const { S3Client, ListObjectsV2Command, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const fs = require('fs').promises;
const path = require('path');
const { PDFLoader } = require('langchain/document_loaders/fs/pdf');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { BedrockEmbeddings } = require('@langchain/community/embeddings/bedrock');
const { FaissStore } = require('@langchain/community/vectorstores/faiss');
const xlsx = require('xlsx');
const os = require('os');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
require('dotenv').config();

function parseLLMOutput(responseText) {
    try {
        // Remove any code block marks and clean the text
        responseText = responseText
            .trim()
            .replace(/^\`+|\`+$/g, '')
            .replace(/\n/g, '')  // Remove newlines
            .replace(/\s+/g, ' ')  // Normalize whitespace
            .trim();
        
        // Try parsing as JSON directly
        return JSON.parse(responseText);
    } catch (error) {
        console.error(`!! Could not parse LLM output as JSON: ${error}`);
        console.log('Output was:\n', responseText);
        return {
            Skills: '',
            'Programming Languages': '',
            'Years of experience': '',
            'Job title': ''
        };
    }
}

class S3ResumeRAGTagExtractor {
    constructor(awsAccessKeyId, awsSecretAccessKey, regionName, faissBaseDir = 'faiss_indexes') {
        const credentials = {
            accessKeyId: awsAccessKeyId,
            secretAccessKey: awsSecretAccessKey
        };

        // Initialize AWS clients
        this.s3Client = new S3Client({
            credentials,
            region: regionName
        });
        
        // Initialize Bedrock client
        this.bedrockRuntime = new BedrockRuntimeClient({
            credentials,
            region: regionName
        });

        this.embedder = new BedrockEmbeddings({
            model: 'amazon.titan-embed-text-v2:0',
            region: regionName,
            credentials: {
                accessKeyId: awsAccessKeyId,
                secretAccessKey: awsSecretAccessKey
            }
        });

        this.faissBaseDir = faissBaseDir;
        fs.mkdir(faissBaseDir, { recursive: true });
    }

    async downloadFromS3(bucket, key, localPath) {
        try {
            const command = new GetObjectCommand({ Bucket: bucket, Key: key });
            const response = await this.s3Client.send(command);
            const chunks = [];
            for await (const chunk of response.Body) {
                chunks.push(chunk);
            }
            await fs.writeFile(localPath, Buffer.concat(chunks));
            return true;
        } catch (error) {
            console.error(`Error downloading ${key} from S3:`, error);
            return false;
        }
    }

    async moveFileInS3(bucket, sourceKey, destinationKey) {
        try {
            // Copy the object to new location
            const copyCommand = new CopyObjectCommand({
                Bucket: bucket,
                CopySource: `${bucket}/${sourceKey}`,
                Key: destinationKey
            });
            await this.s3Client.send(copyCommand);

            // Delete the object from old location
            const deleteCommand = new DeleteObjectCommand({
                Bucket: bucket,
                Key: sourceKey
            });
            await this.s3Client.send(deleteCommand);

            console.log(`Successfully moved ${sourceKey} to ${destinationKey}`);
            return true;
        } catch (error) {
            console.error(`Error moving file in S3:`, error);
            return false;
        }
    }

    async processResumeAndStore(pdfPath, resumeId) {
        const loader = new PDFLoader(pdfPath);
        const docs = await loader.load();
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200
        });
        const chunks = await splitter.splitDocuments(docs);
        const faissDir = path.join(this.faissBaseDir, `${resumeId}_faiss`);
        const vectordb = await FaissStore.fromDocuments(chunks, this.embedder);
        await vectordb.save(faissDir);
        return [vectordb, chunks];
    }

    // Helper function to add delay
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async saveToExcel(results, failedFiles, outputExcel) {
        try {
            let workbook;
            let existingData = [];
            
            // Try to read existing Excel file
            try {
                if (await fs.access(outputExcel).then(() => true).catch(() => false)) {
                    workbook = xlsx.readFile(outputExcel);
                    if (workbook.Sheets['Resume Tags']) {
                        existingData = xlsx.utils.sheet_to_json(workbook.Sheets['Resume Tags']);
                    }
                }
            } catch (error) {
                console.log('No existing Excel file found or error reading it. Creating new file.');
                workbook = xlsx.utils.book_new();
            }

            // If workbook wasn't created from existing file, create new
            if (!workbook) {
                workbook = xlsx.utils.book_new();
            }

            // Merge existing data with new results, avoiding duplicates
            const mergedResults = [...existingData];
            for (const newResult of results) {
                const existingIndex = mergedResults.findIndex(
                    item => item.resume_file_name === newResult.resume_file_name
                );
                if (existingIndex !== -1) {
                    // Update existing entry
                    mergedResults[existingIndex] = newResult;
                } else {
                    // Add new entry
                    mergedResults.push(newResult);
                }
            }

            // Create new worksheet with merged data
            const worksheet = xlsx.utils.json_to_sheet(mergedResults);
            
            // Remove existing sheet if it exists
            if (workbook.Sheets['Resume Tags']) {
                delete workbook.Sheets['Resume Tags'];
                workbook.SheetNames = workbook.SheetNames.filter(name => name !== 'Resume Tags');
            }
            
            // Add the updated worksheet
            xlsx.utils.book_append_sheet(workbook, worksheet, 'Resume Tags');

            // Update failed files sheet
            if (failedFiles.length > 0) {
                const failedSheet = xlsx.utils.json_to_sheet(failedFiles.map(f => ({ file: f })));
                
                // Remove existing failed files sheet if it exists
                if (workbook.Sheets['Failed Files']) {
                    delete workbook.Sheets['Failed Files'];
                    workbook.SheetNames = workbook.SheetNames.filter(name => name !== 'Failed Files');
                }
                
                xlsx.utils.book_append_sheet(workbook, failedSheet, 'Failed Files');
            }

            // Save the updated workbook
            xlsx.writeFile(workbook, outputExcel);
            console.log(`Excel file ${outputExcel} updated successfully`);
        } catch (error) {
            console.error('Error saving results to Excel:', error);
        }
    }

    // Helper function for exponential backoff retry
    async retryWithExponentialBackoff(fn, maxRetries = 5, initialDelay = 1000) {
        let retries = 0;
        while (true) {
            try {
                return await fn();
            } catch (error) {
                if (error.name === 'ThrottlingException' && retries < maxRetries) {
                    const delayTime = initialDelay * Math.pow(2, retries);
                    console.log(`Throttled. Retrying in ${delayTime}ms... (Attempt ${retries + 1}/${maxRetries})`);
                    await this.delay(delayTime);
                    retries++;
                } else {
                    throw error;
                }
            }
        }
    }

    async extractTagsFromChunks(chunks) {
        try {
            const context = chunks.map(c => c.pageContent).join('\n\n');
            const MAX_CONTEXT_CHARS = 12000;
            const truncatedContext = context.length > MAX_CONTEXT_CHARS 
                ? context.substring(0, MAX_CONTEXT_CHARS) 
                : context;

            const prompt = {
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 4000,
                messages: [
                    {
                        role: "user",
                        content: `From the RESUME CONTEXT below, extract:
- Skills (comma-separated)
- Programming Languages (comma-separated)
- Years of experience (integer only)
- Job title (give a generic name for that job title, don't add junior senior etc)
STRICT INSTRUCTIONS: Respond ONLY with STRICT JSON using keys:
'Skills', 'Programming Languages', 'Years of experience', 'Job title'. DO NOT use markdown/code-block/extra explanation.

RESUME CONTEXT:
${truncatedContext}`
                    }
                ]
            };

            console.log('Sending request to Bedrock...');
            // Wrap Bedrock API call in retry logic
            const command = new InvokeModelCommand({
                modelId: "arn:aws:bedrock:us-east-1:533267224629:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0",
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(prompt),
            });

            const response = await this.retryWithExponentialBackoff(
                async () => this.bedrockRuntime.send(command)
            );
            console.log('Response received from Bedrock');
            
            const responseBuffer = await response.body;
            const responseText = new TextDecoder().decode(responseBuffer);
            console.log('Raw response:', responseText);
            
            const result = JSON.parse(responseText);
            console.log('Parsed response:', result);
            
            const content = result.content[0].text;
            console.log(`\n----LLM RAW OUTPUT----\n${content}\n----------------------\n`);
            
            return parseLLMOutput(content);
        } catch (error) {
            console.error('Error in extractTagsFromChunks:', error);
            if (error.response) {
                console.error('Response error:', error.response);
            }
            console.error('Error stack:', error.stack);
            return {
                Skills: '',
                'Programming Languages': '',
                'Years of experience': '',
                'Job title': ''
            };
        }
    }

    async processS3Bucket(bucketName, prefix = '', outputExcel = 'resume_tags.xlsx', batchSize = 100, maxResumes = 200) {
        if (!bucketName) {
            throw new Error('Bucket name is required');
        }
        
        console.log(`Starting to process resumes from bucket: ${bucketName}, prefix: ${prefix}`);
        console.log(`Will process maximum of ${maxResumes} resumes`);
        let continuationToken = null;
        const results = [];
        let totalProcessed = 0;
        let failedFiles = [];
        let processedFiles = new Set(); // Track processed files to avoid duplicates

        while (true) {
            // List objects in the bucket
            const command = new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: prefix,
                MaxKeys: batchSize,
                ...(continuationToken && { ContinuationToken: continuationToken })
            });

            const response = await this.s3Client.send(command);
            
            // Process this batch of files
            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-processor-'));
            
            try {
                for (const obj of response.Contents || []) {
                    if (!obj.Key.toLowerCase().endsWith('.pdf')) {
                        continue;
                    }

                    // Skip if already processed
                    if (processedFiles.has(obj.Key)) {
                        continue;
                    }

                    const resumeId = path.basename(obj.Key, '.pdf');
                    const tempPdfPath = path.join(tempDir, `${resumeId}.pdf`);

                    try {
                        console.log(`\nProcessing: ${obj.Key}`);
                        
                        // Add delay between processing each file (2 seconds)
                        await this.delay(2000);
                        
                        // Download PDF from S3
                        if (!await this.downloadFromS3(bucketName, obj.Key, tempPdfPath)) {
                            failedFiles.push(obj.Key);
                            console.error(`Failed to download: ${obj.Key}`);
                            continue;
                        }

                        // Process the resume
                        const [_, chunks] = await this.processResumeAndStore(tempPdfPath, resumeId);
                        const tags = await this.extractTagsFromChunks(chunks);
                        
                        // Store results with just the filename, without the path prefix
                        results.push({
                            resume_file_name: path.basename(obj.Key),
                            ...tags
                        });

                        // Move the processed file to a 'processed' folder
                        const processedPrefix = prefix.replace(/\/$/, '') + '_processed/';
                        const destinationKey = processedPrefix + path.basename(obj.Key);
                        await this.moveFileInS3(bucketName, obj.Key, destinationKey);
                        
                        totalProcessed++;
                        console.log(`Done: ${obj.Key} (Total processed: ${totalProcessed} of ${maxResumes})`);

                        // Save results to Excel after each successful processing
                        await this.saveToExcel(results, failedFiles, outputExcel);

                        // Check if we've reached the maximum number of resumes
                        if (totalProcessed >= maxResumes) {
                            console.log(`Reached maximum number of resumes (${maxResumes}). Stopping processing.`);
                            continuationToken = null; // This will stop the outer loop
                            break; // This will break the inner loop
                        }

                    } catch (error) {
                        console.error(`Failed to process ${obj.Key}:`, error);
                        failedFiles.push(obj.Key);
                    }
                    // Clean up the temporary file
                    try {
                        if (await fs.access(tempPdfPath).then(() => true).catch(() => false)) {
                            await fs.unlink(tempPdfPath);
                        }
                    } catch (error) {
                        console.error(`Error cleaning up ${tempPdfPath}:`, error);
                    }
                    // Mark file as processed regardless of success/failure
                    processedFiles.add(obj.Key);
                }
            } finally {
                // Clean up temporary directory
                try {
                    if (await fs.access(tempDir).then(() => true).catch(() => false)) {
                        await fs.rm(tempDir, { recursive: true, force: true });
                    }
                } catch (error) {
                    console.error(`Error cleaning up temp directory ${tempDir}:`, error);
                }
            }

            // Check if there are more files to process
            if (!response.IsTruncated) {
                break;
            }
            continuationToken = response.NextContinuationToken;
        }

        // Save or update results in Excel
        if (results.length > 0) {
            try {
                let workbook;
                let existingData = [];
                
                // Try to read existing Excel file
                try {
                    if (await fs.access(outputExcel).then(() => true).catch(() => false)) {
                        workbook = xlsx.readFile(outputExcel);
                        if (workbook.Sheets['Resume Tags']) {
                            existingData = xlsx.utils.sheet_to_json(workbook.Sheets['Resume Tags']);
                        }
                    }
                } catch (error) {
                    console.log('No existing Excel file found or error reading it. Creating new file.');
                    workbook = xlsx.utils.book_new();
                }

                // If workbook wasn't created from existing file, create new
                if (!workbook) {
                    workbook = xlsx.utils.book_new();
                }

                // Merge existing data with new results, avoiding duplicates
                const mergedResults = [...existingData];
                for (const newResult of results) {
                    const existingIndex = mergedResults.findIndex(
                        item => item.resume_file_name === newResult.resume_file_name
                    );
                    if (existingIndex !== -1) {
                        // Update existing entry
                        mergedResults[existingIndex] = newResult;
                    } else {
                        // Add new entry
                        mergedResults.push(newResult);
                    }
                }

                // Create new worksheet with merged data
                const worksheet = xlsx.utils.json_to_sheet(mergedResults);
                
                // Remove existing sheet if it exists
                if (workbook.Sheets['Resume Tags']) {
                    delete workbook.Sheets['Resume Tags'];
                    workbook.SheetNames = workbook.SheetNames.filter(name => name !== 'Resume Tags');
                }
                
                // Add the updated worksheet
                xlsx.utils.book_append_sheet(workbook, worksheet, 'Resume Tags');

                // Update failed files sheet
                if (failedFiles.length > 0) {
                    const failedSheet = xlsx.utils.json_to_sheet(failedFiles.map(f => ({ file: f })));
                    
                    // Remove existing failed files sheet if it exists
                    if (workbook.Sheets['Failed Files']) {
                        delete workbook.Sheets['Failed Files'];
                        workbook.SheetNames = workbook.SheetNames.filter(name => name !== 'Failed Files');
                    }
                    
                    xlsx.utils.book_append_sheet(workbook, failedSheet, 'Failed Files');
                }

                // Save the updated workbook
                xlsx.writeFile(workbook, outputExcel);
                console.log(`\nProcessing Summary:`);
                console.log(`- Total processed: ${totalProcessed}`);
                console.log(`- Successful: ${results.length}`);
                console.log(`- Failed: ${failedFiles.length}`);
                console.log(`- Results written to: ${excelFileName}`);
            } catch (error) {
                console.error('Error saving results to Excel:', error);
                throw error;
            }
        } else {
            console.log('No resumes were successfully processed.');
            if (failedFiles.length > 0) {
                console.log(`${failedFiles.length} files failed to process.`);
            }
        }
    }
}

// Usage Example:
if (require.main === module) {
    const run = async () => {
        // AWS Credentials should be set via environment variables:
        // AWS_ACCESS_KEY_ID
        // AWS_SECRET_ACCESS_KEY
        // AWS_REGION
        const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
        const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
        const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

        // S3 Configuration
        const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'resume-ranking-bucket';
        const PREFIX = process.env.S3_PREFIX || 'resume_input/';
        const EXCEL_OUT = process.env.EXCEL_OUTPUT || 'resume_tags.xlsx';
        
        // Create extractor instance
        const extractor = new S3ResumeRAGTagExtractor(
            AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY,
            AWS_REGION
        );
        
        // Process resumes in the bucket (limited to 200)
        await extractor.processS3Bucket(
            BUCKET_NAME,
            PREFIX,
            EXCEL_OUT,
            100,  // Batch size for processing files
            250   // Maximum number of resumes to process
        );
    };

    run().catch(console.error);
}

module.exports = S3ResumeRAGTagExtractor;
