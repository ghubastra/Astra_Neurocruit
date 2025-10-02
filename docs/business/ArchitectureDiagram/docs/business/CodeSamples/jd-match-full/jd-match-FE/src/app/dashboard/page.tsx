"use client";

import React, { useState } from "react";
import Sidebar from "../../components/Sidebar";

interface Resume {
  name: string;
  score: number;
}

interface ApiResponse {
  success: boolean;
  jdTags: {
    Skills: string;
    "Programming Languages": string;
    "Years of experience": number;
  };
  matchingResumes: string[];
  notFound: string[];
  scores: { [key: string]: number };
}

export default function DashboardPage() {
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState(false);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [error, setError] = useState("");
  const [jdTags, setJdTags] = useState<ApiResponse['jdTags'] | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResumes([]);
    setJdTags(null);
    
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/match-resumes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jdText: jd,
          topn: 3
        }),
      });

      if (!response.ok) {
        throw new Error('Network response was not ok');
      }

      const data: ApiResponse = await response.json();
      
      if (!data.success) {
        throw new Error('Failed to find matching resumes');
      }

      setJdTags(data.jdTags);
      // Convert scores to array of resumes
      const matchedResumes = Object.entries(data.scores)
        .filter(([name, score]) => score >= 60) // Only show resumes with score >= 60
        .map(([name, score]) => ({
          name,
          score
        }))
        .sort((a, b) => b.score - a.score);
      
      setResumes(matchedResumes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch resumes. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-gray-900 to-gray-800">
      <Sidebar current="/dashboard" />
  <main className="flex-1 flex flex-col min-h-screen bg-[#161C24]">
        {/* Header */}
        <header className="h-16 border-b border-[#1E293B] flex items-center px-8 bg-[#212B36] shadow z-10">
          <h1 className="text-xl font-extrabold text-white tracking-tight">Dashboard</h1>
          <div className="ml-auto flex items-center gap-4">
            <div className="w-9 h-9 rounded-full bg-[#2065D1] flex items-center justify-center text-white font-bold shadow">U</div>
          </div>
        </header>
        {/* Split screen */}
  <div className="flex flex-1 overflow-hidden">
          {/* Left: JD input */}
          <section className="w-1/2 flex flex-col items-center justify-center bg-[#212B36] p-10">
            <form onSubmit={handleSearch} className="w-full max-w-lg bg-[#1E293B] rounded-2xl shadow-xl p-8 flex flex-col gap-5 border border-[#212B36]">
              <label htmlFor="jd" className="block text-gray-200 text-lg font-semibold mb-1">
                Paste Job Description
              </label>
              <textarea
                id="jd"
                className="min-h-[160px] px-4 py-3 rounded-xl bg-[#161C24] text-white border border-[#212B36] focus:outline-none focus:ring-2 focus:ring-[#2065D1] resize-vertical text-base font-normal"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                required
                placeholder="Paste or type the job description here..."
              />
              <button
                type="submit"
                className="mt-2 py-3 rounded-xl bg-[#2065D1] hover:bg-blue-700 text-white font-semibold transition-colors duration-200 shadow disabled:opacity-60"
                disabled={loading}
              >
                {loading ? "Searching..." : "Find Matching Resumes"}
              </button>
              {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
            </form>
          </section>
          {/* Right: Analysis & Results */}
          <section className="w-1/2 flex flex-col bg-[#161C24] p-10 overflow-y-auto">
            <div className="flex flex-col gap-6 max-w-lg mx-auto w-full">
              {/* JD Analysis */}
              {jdTags && (
                <div className="w-full bg-[#1E293B] rounded-2xl shadow-xl p-8 border border-[#212B36]">
                  <h2 className="text-lg font-semibold text-white mb-4">JD Analysis</h2>
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-medium text-gray-400">Required Skills</h3>
                      <p className="text-white mt-1">{jdTags.Skills}</p>
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-gray-400">Programming Languages</h3>
                      <p className="text-white mt-1">{jdTags["Programming Languages"]}</p>
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-gray-400">Years of Experience</h3>
                      <p className="text-white mt-1">{jdTags["Years of experience"]} years</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Matching Resumes */}
              <div className="w-full bg-[#1E293B] rounded-2xl shadow-xl p-8 border border-[#212B36]">
                <h2 className="text-lg font-semibold text-white mb-4">Matching Resumes</h2>
                {resumes.length === 0 && !loading && (
                  <div className="text-gray-400 text-center mt-8">
                    {error || "No matching resumes found. Try adjusting your job description."}
                  </div>
                )}
                <div className="max-h-[60vh] overflow-y-auto pr-2">
                  <ul className="space-y-4">
                {resumes.map((resume) => (
                    <li key={resume.name} className="grid grid-cols-[1fr,auto] gap-4 bg-[#212B36] rounded-xl p-4 border border-[#161C24] shadow-sm">
                      <div className="flex flex-col min-w-0">
                        <span className="text-white font-medium truncate">{resume.name}</span>
                        <span className="text-sm text-gray-400">Match Score: {resume.score}%</span>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => window.open(`${process.env.NEXT_PUBLIC_API_URL}/resumes/${resume.name}`, '_blank')}
                          className="px-4 py-2 rounded bg-[#2065D1] hover:bg-blue-700 text-white text-sm font-semibold transition-colors duration-200 whitespace-nowrap"
                        >
                          View
                        </button>
                        <a
                          href={`${process.env.NEXT_PUBLIC_API_URL}/resumes/download/${resume.name}`}
                          download
                          className="px-4 py-2 rounded bg-green-500 hover:bg-green-600 text-white text-sm font-semibold transition-colors duration-200 whitespace-nowrap"
                        >
                          Download
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
