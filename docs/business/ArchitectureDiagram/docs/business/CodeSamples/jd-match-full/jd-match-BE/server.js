require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const sequelize = require('./config/database');

const app = express();
const port = process.env.PORT || 3000;

// Initialize AWS clients
const bedrockRuntime = new BedrockRuntimeClient({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  region: process.env.AWS_REGION || 'us-east-1'
});

const s3Client = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  region: process.env.AWS_REGION || 'us-east-1'
});

// Connect to MySQL and sync models
sequelize.sync({ alter: true })
  .then(() => {
    console.log('Connected to MySQL database');
  })
  .catch(err => {
    console.error('Unable to connect to the database:', err);
  });

// Middleware
app.use(cors());
app.use(express.json());

// Auth routes
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Stream resume from S3
app.get('/resumes/:filename', async (req, res) => {
  const filename = req.params.filename;
  const s3Key = `resume_input_processed/${filename}`; // Processed resumes folder

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME || 'resume-ranking-bucket',
      Key: s3Key
    });

    const response = await s3Client.send(command);
    res.setHeader('Content-Type', 'application/pdf');
    response.Body.pipe(res);
  } catch (error) {
    console.error(`Error streaming file from S3: ${error}`);
    res.status(404).send('File not found');
  }
});

// Download resume route
app.get('/resumes/download/:filename', async (req, res) => {
  const filename = req.params.filename;
  const s3Key = `resume_input_processed/${filename}`; // Processed resumes folder

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME || 'resume-ranking-bucket',
      Key: s3Key
    });

    const response = await s3Client.send(command);
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/pdf');
    response.Body.pipe(res);
  } catch (error) {
    console.error(`Error downloading file from S3: ${error}`);
    res.status(404).send('File not found');
  }
});

// Helper Functions
const parseLLMOutput = (responseText) => {
  try {
    // Remove any code block marks and clean the text
    responseText = responseText
      .trim()
      .replace(/^\`\`\`json|\`\`\`|\`/g, '') // Remove ```json, ``` or ` marks
      .replace(/\n/g, '')  // Remove newlines
      .replace(/\s+/g, ' ')  // Normalize whitespace
      .trim();
    
    // Try parsing as JSON
    return JSON.parse(responseText);
  } catch (error) {
    console.error(`Could not parse LLM output as JSON: ${error}`);
    console.log('Output was:\n', responseText);
    return null;
  }
};

const mergeRowFields = (row) => {
  return `Skills: ${row['Skills'] || ''}\n` +
    `Programming Languages: ${row['Programming Languages'] || ''}\n` +
    `Years of experience: ${row['Years of experience'] || ''}\n` +
    (row['Achievements'] ? `Other: ${row['Achievements']}` : '');
};

// Helper function for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry function with exponential backoff
async function retryWithExponentialBackoff(fn, maxRetries = 5, initialDelay = 1000) {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (error.name === 'ThrottlingException' && retries < maxRetries) {
        const delayTime = initialDelay * Math.pow(2, retries);
        console.log(`Rate limited. Retrying in ${delayTime}ms... (Attempt ${retries + 1}/${maxRetries})`);
        await delay(delayTime);
        retries++;
      } else {
        throw error;
      }
    }
  }
}

const extractJdTags = async (jdText) => {
  const prompt = `Given the following job description, extract:
- Skills (comma-separated)
- Programming Languages (comma-separated)
- Years of experience required (integer, use the highest if a range is provided, or estimate if not explicit)
Respond ONLY with valid JSON using the keys: 'Skills', 'Programming Languages', 'Years of experience'.

Job Description:
${jdText}`;

  try {
    // Wrap the API call in the retry function
    const result = await retryWithExponentialBackoff(async () => {
      const command = new InvokeModelCommand({
        modelId: "arn:aws:bedrock:us-east-1:533267224629:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4000,
          messages: [{ 
            role: "user", 
            content: prompt 
          }]
        })
      });

      const response = await bedrockRuntime.send(command);
      const responseBuffer = await response.body;
      const responseText = new TextDecoder().decode(responseBuffer);
      const result = JSON.parse(responseText);
      const content = result.content[0].text;
      const parsedContent = parseLLMOutput(content);
      if (!parsedContent) {
        throw new Error('Failed to parse LLM response');
      }
      return parsedContent;
    });
    return result;
  } catch (error) {
    console.error('Error extracting JD tags:', error);
    return null;
  }
};

const findBestResumes = async (jdTags, resumeData, topn = 3, threshold = 60) => {
  const resumes = resumeData.map(row => ({
    filename: row['resume_file_name'],
    summary: mergeRowFields(row)
  }));

  const jdDesc = jdTags ? `Skills: ${jdTags['Skills'] || ''}
Programming Languages: ${jdTags['Programming Languages'] || ''}
Years of experience: ${jdTags['Years of experience'] || ''}` : '';

  const prompt = `You are an expert recruitment specialist. You will evaluate resumes against a job description and provide match scores.

JOB DESCRIPTION:
${jdDesc}

KEY REQUIREMENTS:
- Skills: ${jdTags['Skills']}
- Programming Languages: ${jdTags['Programming Languages']}
- Years of Experience: ${jdTags['Years of experience']}

EVALUATION INSTRUCTIONS:
Review each resume carefully and score based on:
1. Technical Skills Match (alignment with required skills)
2. Programming Languages Match
3. Years of Experience Match
4. Overall Role & Domain Fit

Score Guidelines:
- 90-100: Perfect match across all criteria
- 75-89: Strong match with minor gaps
- 60-74: Good match with some gaps
- Below 60: Not recommended

REQUIRED OUTPUT FORMAT: Strict JSON object with filename:score pairs. Example:
{"resume.pdf": 85}

RESUMES TO EVALUATE:
${resumes.map(res => `${res.filename}:\n${res.summary}`).join('\n---------------------------\n')}`;

  try {
    const makeRequest = async () => {
      const command = new InvokeModelCommand({
        modelId: "arn:aws:bedrock:us-east-1:533267224629:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4000,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        })
      });

      const response = await bedrockRuntime.send(command);
      const responseBuffer = await response.body;
      const responseText = new TextDecoder().decode(responseBuffer);
      const result = JSON.parse(responseText);
      return result;
    };

    const result = await retryWithExponentialBackoff(makeRequest);
    const content = result.content[0].text;
    console.log('Raw LLM response for resume matching:', content);
    
    let scores = {};
    try {
      // Clean up the response to ensure valid JSON
      let cleanedContent = content.replace(/[\r\n]+/g, ' ') // Remove newlines
                          .replace(/'/g, '"')         // Replace single quotes with double quotes
                          .replace(/,\s*}/g, '}')     // Remove trailing commas
                          .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":') // Ensure property names are quoted
                          .trim();
      
      // Extract only the JSON object if there's additional text
      const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanedContent = jsonMatch[0];
      }
      
      console.log('Cleaned JSON:', cleanedContent);
      const obj = JSON.parse(cleanedContent);
      
      if (typeof obj === 'object' && obj !== null) {
        // Convert and validate scores
        scores = Object.fromEntries(
          Object.entries(obj)
            .filter(([filename, score]) => {
              const isValidFilename = resumeData.some(row => row.resume_file_name === filename);
              const isValidScore = typeof score === 'number' || (typeof score === 'string' && !isNaN(score));
              return isValidFilename && isValidScore;
            })
            .map(([filename, score]) => [filename, parseInt(score)])
        );
      }
    } catch (error) {
      console.error('Error parsing LLM response:', error);
      console.error('Problematic content:', content);
      return { selected: [], scores: {} };
    }

    console.log('Processed scores before filtering:', scores);

    // Filter and sort results
    const validScores = Object.entries(scores)
      .filter(([_, score]) => score >= threshold)
      .sort(([, a], [, b]) => b - a);

    console.log('Valid scores after filtering:', validScores);
    
    const selected = validScores.slice(0, topn).map(([filename]) => filename);
    console.log('Selected resumes:', selected);

    console.log('Returning from findBestResumes:', {
      selected,
      scores
    });
    
    return {
      selected,
      scores
    };
  } catch (error) {
    console.error('Error finding best resumes:', error);
    return { selected: [], scores: {} };
  }
};

const copyFilteredPdfs = (filteredFiles) => {
  const sourceDir = path.resolve(__dirname, '..');
  const outputDir = process.env.OUTPUT_DIR;
  const done = [];
  const notFound = [];

  for (const filename of filteredFiles) {
    const srcPath = path.join(sourceDir, filename);
    const dstPath = path.join(outputDir, filename);
    
    try {
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, dstPath);
        done.push(filename);
      } else {
        notFound.push(filename);
      }
    } catch (error) {
      console.error(`Error copying ${filename}:`, error);
      notFound.push(filename);
    }
  }

  return { done, notFound };
};

// API Endpoints
app.post('/api/match-resumes', async (req, res) => {
  
  try {
    const { jdText, topn = 3 } = req.body;

    if (!jdText) {
      return res.status(400).json({ error: 'Job description is required' });
    }

    // Read Excel file
    const workbook = XLSX.readFile(process.env.EXCEL_PATH);
    const sheetName = 'Resume Tags';
    
    // Check if Resume Tags sheet exists
    if (!workbook.SheetNames.includes(sheetName)) {
      return res.status(404).json({ error: 'Resume Tags sheet not found in Excel file' });
    }
    
    const resumeData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!resumeData.length) {
      return res.status(404).json({ error: 'No resume data found in Resume Tags sheet' });
    }

    // Extract JD tags
    const jdTags = await extractJdTags(jdText);
    if (!jdTags) {
      return res.status(400).json({ error: 'Could not extract tags from job description' });
    }

    console.log('JD Tags:', jdTags);

    // Find best matches with error handling
    const matchResult = await findBestResumes(jdTags, resumeData, topn);
    console.log('Raw Match Result:', JSON.stringify(matchResult, null, 2));
    
    // Ensure we have valid data
    const selected = matchResult.selected || [];
    const scores = matchResult.scores || {};
    
    console.log('Final Selected:', selected);
    console.log('Final Scores:', JSON.stringify(scores, null, 2));

    // Copy PDFs for any selected resumes
    const copyResult = copyFilteredPdfs(selected);
    console.log('Copy Result:', copyResult);

    // Prepare response
    const response = {
      success: selected.length > 0,
      jdTags,
      matchingResumes: copyResult.done,
      notFound: copyResult.notFound,
      scores
    };

    // Add message only if no matches found
    if (selected.length === 0) {
      response.message = 'No resumes with relevance =60% were found for this JD';
    }

    console.log('Final API Response:', JSON.stringify(response, null, 2));
    return res.json(response);

  } catch (error) {
    console.error('Error in match-resumes endpoint:', error);
    console.error(error.stack);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log(`Excel Path: ${process.env.EXCEL_PATH}`);
  console.log(`Output Directory: ${process.env.OUTPUT_DIR}`);
});
