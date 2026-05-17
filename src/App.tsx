import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, doc, serverTimestamp, setDoc, query, getDocs } from 'firebase/firestore';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { GoogleGenAI } from '@google/genai';
import Markdown from 'react-markdown';

type NicheKey = 'news' | 'motivational' | 'storyteller' | 'tech_reviewer';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface NicheConfig {
  label: string;
  visual: string;
  style: string;
  dotColor: string;
}

const NICHES: Record<NicheKey, NicheConfig> = {
  news: {
    label: "News Broadcaster",
    visual: "closeup: A cinematic news-style video of an American commanding, charismatic personality with authority and presence, around 45–50 years old professional male news anchor as a successful broadcaster speaking directly to the camera.",
    style: "Perfect mouth movement, realistic lip sync, calm but urgent news tone, professional broadcast delivery.",
    dotColor: "bg-emerald-500"
  },
  motivational: {
    label: "Motivational Speaker",
    visual: "closeup: A highly cinematic and dramatic video of a passionate, inspiring motivational speaker, around 35-40 years old, speaking powerfully and directly to the camera with intense eye contact, dramatic lighting.",
    style: "Perfect mouth movement, realistic lip sync, powerful emotion, confident and energetic delivery, inspiring tone.",
    dotColor: "bg-orange-500"
  },
  storyteller: {
    label: "Documentary Voice",
    visual: "closeup: A warm and inviting cinematic video of an experienced storyteller sitting in a cozy, dimly lit room, speaking softly and engagingly to the camera.",
    style: "Perfect mouth movement, realistic lip sync, calm and captivating storytelling tone, emotional resonance.",
    dotColor: "bg-blue-500"
  },
  tech_reviewer: {
    label: "Cinematic Narration",
    visual: "closeup: A modern, crisp style video of a young, energetic tech reviewer in a studio with RGB lighting, speaking directly to the camera with excitement.",
    style: "Perfect mouth movement, realistic lip sync, upbeat and clear delivery, engaging YouTube tech creator tone.",
    dotColor: "bg-purple-500"
  }
};

function splitScriptIntoChunks(script: string, maxWords: number = 22): string[] {
  const text = script.replace(/\s+/g, ' ').trim();
  if (!text) return [];

  // Split into sentences, keeping punctuation
  const sentencesPatterns = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  
  const chunks: string[] = [];
  let currentWords: string[] = [];

  for (let i = 0; i < sentencesPatterns.length; i++) {
    const sentenceWords = sentencesPatterns[i].trim().split(' ');
    if (!sentenceWords[0]) continue;

    if (currentWords.length + sentenceWords.length <= maxWords) {
      currentWords = currentWords.concat(sentenceWords);
    } else {
      if (currentWords.length > 0) {
        chunks.push(currentWords.join(' '));
        currentWords = [];
      }
      
      if (sentenceWords.length > maxWords) {
        let chunk = [];
        for (let j = 0; j < sentenceWords.length; j++) {
           chunk.push(sentenceWords[j]);
           if (chunk.length >= maxWords) {
             chunks.push(chunk.join(' '));
             chunk = [];
           }
        }
        if (chunk.length > 0) {
           currentWords = chunk;
        }
      } else {
        currentWords = sentenceWords;
      }
    }
  }

  if (currentWords.length > 0) {
    chunks.push(currentWords.join(' '));
  }

  return chunks;
}

export default function App() {
  const [currentTab, setCurrentTab] = useState<'splitter' | 'ideation'>('splitter');
  const [competitorTranscript, setCompetitorTranscript] = useState("");
  const [ideationResult, setIdeationResult] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const [script, setScript] = useState("");
  const [selectedNiche, setSelectedNiche] = useState<NicheKey>('news');
  const [chunks, setChunks] = useState<string[]>([]);
  const [copiedStates, setCopiedStates] = useState<Record<number, boolean>>({});
  
  const [user, setUser] = useState<User | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [structures, setStructures] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingStructure, setIsSavingStructure] = useState(false);
  const [showStructures, setShowStructures] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  // Script Generator State
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [activeStrategy, setActiveStrategy] = useState<any>(null);
  const [genTopic, setGenTopic] = useState("");
  const [genLanguage, setGenLanguage] = useState("Urdu");
  const [genResult, setGenResult] = useState("");
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);

  const [wordsPerChunk, setWordsPerChunk] = useState(25);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        fetchHistory(currentUser.uid);
        fetchStructures(currentUser.uid);
      } else {
        setHistory([]);
        setStructures([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const fetchHistory = async (userId: string) => {
    const pathForGetDocs = `users/${userId}/scripts`;
    try {
      const q = query(collection(db, pathForGetDocs));
      const querySnapshot = await getDocs(q);
      const scripts = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      scripts.sort((a: any, b: any) => {
        if (!a.createdAt || !b.createdAt) return 0;
        return b.createdAt.toMillis() - a.createdAt.toMillis();
      });
      setHistory(scripts);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, pathForGetDocs);
    }
  };

  const fetchStructures = async (userId: string) => {
    const pathForGetDocs = `users/${userId}/structures`;
    try {
      const q = query(collection(db, pathForGetDocs));
      const querySnapshot = await getDocs(q);
      const structs = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      structs.sort((a: any, b: any) => {
        if (!a.createdAt || !b.createdAt) return 0;
        return b.createdAt.toMillis() - a.createdAt.toMillis();
      });
      setStructures(structs);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, pathForGetDocs);
    }
  };

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;

  const handleGenerate = async () => {
    const newChunks = splitScriptIntoChunks(script, wordsPerChunk);
    setChunks(newChunks);
    setCopiedStates({});

    if (user && newChunks.length > 0) {
       setIsSaving(true);
       const scriptId = crypto.randomUUID();
       const pathForWrite = `users/${user.uid}/scripts`;
       try {
         await setDoc(doc(db, pathForWrite, scriptId), {
           userId: user.uid,
           scriptText: script.trim(),
           niche: selectedNiche,
           wordCount: script.trim().split(/\s+/).length,
           chunks: newChunks,
           createdAt: serverTimestamp()
         });
         fetchHistory(user.uid);
       } catch (error) {
         handleFirestoreError(error, OperationType.WRITE, `${pathForWrite}/${scriptId}`);
       } finally {
         setIsSaving(false);
       }
    }
  };

  const generatePromptForChunk = (chunk: string, index: number) => {
    const niche = NICHES[selectedNiche];
    return `Part ${index + 1}:\n${niche.visual}\n\nhe says: "${chunk}"\n\n${niche.style}\n\nThe user is 100% completely in the video.`;
  };

  const handleCopy = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStates(prev => ({ ...prev, [index]: true }));
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  const handleAnalyze = async () => {
    if (!competitorTranscript.trim()) return;
    setIsAnalyzing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY });
      const prompt = `You are a master TikTok/Reels viral content strategist and copywriter.
I will provide transcripts of viral talking-head videos from a competitor.
Analyze them and do a complete "post-mortem" of their viral formula.

Task:
1. Identify their Core Hooks, Pacing, Retention Tricks, and Call to Actions.
2. Based on this winning formula, generate 5 completely new, insanely engaging talking-video scripts (topics & full 60-second scripts) that are even better than the competitor's. 
3. Make the content extremely captivating ("chas aagye"), high-retention, and easy to record.
4. Output in clean Markdown format to display properly on the UI. Make the text easily readable.

Competitor Transcripts:
${competitorTranscript}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      setIdeationResult(response.text || "");
    } catch (err) {
      console.error("Analysis failed", err);
      setIdeationResult("Failed to analyze. Check your API Key or try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const currentAvgWordCount = React.useMemo(() => {
    if (!competitorTranscript.trim()) return 0;
    const allWordsCount = competitorTranscript.trim().split(/\s+/).length;
    const blocksCount = Math.max(1, competitorTranscript.trim().split(/\n\s*\n/).filter(x => x.trim().length > 10).length);
    return Math.round(allWordsCount / blocksCount);
  }, [competitorTranscript]);

  const handleSaveStructure = async () => {
    if (!user || !ideationResult) return;
    setIsSavingStructure(true);
    const structureId = crypto.randomUUID();
    const pathForWrite = `users/${user.uid}/structures`;
    try {
      await setDoc(doc(db, pathForWrite, structureId), {
        userId: user.uid,
        analysisText: ideationResult,
        avgWordCount: currentAvgWordCount,
        createdAt: serverTimestamp()
      });
      fetchStructures(user.uid);
      // Optional: show a small toast or notification
    } catch (error) {
       handleFirestoreError(error, OperationType.WRITE, `${pathForWrite}/${structureId}`);
    } finally {
      setIsSavingStructure(false);
    }
  };

  const openGenerator = (strategy: any) => {
    setActiveStrategy(strategy);
    setGenTopic("");
    setGenResult("");
    setGeneratorOpen(true);
  };

  const openGeneratorFromCurrent = () => {
    setActiveStrategy({ analysisText: ideationResult });
    setGenTopic("");
    setGenResult("");
    setGeneratorOpen(true);
  };

  const generateCleanScript = async () => {
    if (!activeStrategy) return;
    setIsGeneratingScript(true);
    try {
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY });
      const prompt = `You are an elite TikTok/Reels scriptwriter.
Apply this exact viral formula/strategy: 
${activeStrategy.analysisText}

Task: Write a highly engaging 60-second talking-head video script about: "${genTopic || 'A trending topic in this niche'}".
Language: ${genLanguage}.

CRITICAL REQUIREMENTS:
- Output ONLY the spoken words. No scene directions, no [Hook] labels, no intro/outro text, no formatting.
- Purely ready-to-voice text so it can be directly put into a teleprompter or chunk splitter.
- Ensure the tone matches the viral formula perfectly.
- Keep it concise, high retention, engaging ("chas aagye").`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      setGenResult(response.text?.trim() || "");
    } catch(err) {
      console.error(err);
      setGenResult("Failed to generate.");
    } finally {
      setIsGeneratingScript(false);
    }
  };

  const sendToSplitter = () => {
     setScript(genResult);
     setCurrentTab('splitter');
     setGeneratorOpen(false);
     setShowStructures(false);
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#0a0a0a] text-zinc-100 font-sans overflow-hidden">
      {/* Script Generator Modal */}
      {generatorOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
           <div className="bg-[#0a0a0a] border border-zinc-800 rounded-2xl w-full max-w-2xl flex flex-col overflow-hidden max-h-full">
              <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-900/50">
                 <h3 className="font-bold text-zinc-200">Generate Ready-to-Voice Script</h3>
                 <button onClick={() => setGeneratorOpen(false)} className="text-zinc-500 hover:text-white">
                   <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"/></svg>
                 </button>
              </div>
              <div className="p-6 flex flex-col gap-4 overflow-y-auto custom-scrollbar">
                 <div className="flex gap-4">
                    <div className="flex-1">
                       <label className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-2 block">Topic / Idea (Optional)</label>
                       <input type="text" value={genTopic} onChange={e=>setGenTopic(e.target.value)} placeholder="e.g. 3 rules of discipline..." className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm text-white focus:outline-none focus:border-emerald-500" />
                    </div>
                    <div className="w-1/3">
                       <label className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-2 block">Language</label>
                       <select value={genLanguage} onChange={e=>setGenLanguage(e.target.value)} className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 appearance-none">
                          <option value="Urdu">Urdu</option>
                          <option value="Roman Urdu">Roman Urdu</option>
                          <option value="Hindi">Hindi</option>
                          <option value="English">English</option>
                       </select>
                    </div>
                 </div>
                 
                 <button 
                   onClick={generateCleanScript}
                   disabled={isGeneratingScript}
                   className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg text-xs uppercase tracking-widest transition-colors shadow-lg shadow-emerald-900/20"
                 >
                   {isGeneratingScript ? "GENERATING SCRIPT..." : genResult ? "RETRY WITH SAME SETTINGS" : "GENERATE SCRIPT"}
                 </button>

                 {genResult && (
                   <div className="mt-4 flex flex-col gap-3">
                     <label className="text-[10px] uppercase tracking-widest text-emerald-500 font-bold">Generated Script (Ready to Voice)</label>
                     <textarea 
                       value={genResult}
                       onChange={e=>setGenResult(e.target.value)}
                       className="w-full h-48 bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-sm text-zinc-200 resize-none custom-scrollbar focus:outline-none focus:border-emerald-500"
                     />
                     <button 
                       onClick={sendToSplitter}
                       className="w-full bg-zinc-100 hover:bg-white text-black font-bold py-3 rounded-lg text-xs uppercase tracking-widest transition-colors"
                     >
                       SEND TO SPLITTER
                     </button>
                   </div>
                 )}
              </div>
           </div>
        </div>
      )}

      {/* Header Section */}
      <header className="flex flex-col sm:flex-row items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-zinc-800 bg-[#0f0f0f] shrink-0 gap-4 sm:gap-0">
        <div className="flex items-center gap-4 sm:gap-6 w-full sm:w-auto justify-between sm:justify-start">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-emerald-500 rounded-sm flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-lg sm:text-xl font-medium tracking-tight whitespace-nowrap">VEO 3.1 <span className="text-zinc-500 font-light italic hidden lg:inline">Script Architect</span></h1>
          </div>
          <div className="flex bg-zinc-900 rounded-lg p-1 border border-zinc-800 shrink-0">
            <button 
              onClick={() => setCurrentTab('splitter')} 
              className={`px-3 sm:px-4 py-1.5 text-[10px] sm:text-xs font-medium rounded transition-colors ${currentTab === 'splitter' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              SPLITTER
            </button>
            <button 
              onClick={() => setCurrentTab('ideation')} 
              className={`px-3 sm:px-4 py-1.5 text-[10px] sm:text-xs font-medium rounded transition-colors ${currentTab === 'ideation' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              IDEATION LAB
            </button>
          </div>
        </div>
        
        <div className="flex items-center w-full sm:w-auto justify-center sm:justify-end">
          {user ? (
            <div className="flex items-center justify-between w-full sm:w-auto gap-4">
              <div className="hidden md:flex flex-col items-end">
                <span className="text-xs text-zinc-300 font-medium">{user.email?.split('@')[0]}</span>
                <span className="text-[10px] text-emerald-500 uppercase tracking-widest font-bold">Pro Access</span>
              </div>
              <div className="flex items-center gap-2 md:border-l md:border-zinc-800 md:pl-4">
                <button 
                  onClick={() => currentTab === 'splitter' ? setShowHistory(!showHistory) : setShowStructures(!showStructures)}
                  className={`px-3 sm:px-4 py-2 rounded text-[10px] sm:text-xs font-bold uppercase tracking-widest transition-colors ${
                    (currentTab === 'splitter' && showHistory) || (currentTab === 'ideation' && showStructures)
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                      : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 border border-transparent'
                  }`}
                >
                  {currentTab === 'splitter' ? 'History' : 'Saved'}
                </button>
                <div className="relative">
                  <button 
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors shrink-0"
                  >
                    <svg className="w-4 h-4" autoFocus={false} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                  </button>
                  {showUserMenu && (
                    <div className="absolute right-0 top-full mt-2 w-32 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1 z-50 overflow-hidden">
                      <button 
                        onClick={() => { setShowUserMenu(false); logout(); }} 
                        className="w-full text-left px-4 py-2.5 text-[10px] text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors uppercase tracking-widest font-bold"
                      >
                        Logout
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <button 
              onClick={signInWithGoogle}
              className="w-full sm:w-auto bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] sm:text-xs font-bold px-4 py-2 rounded transition-colors uppercase tracking-widest"
            >
              LOGIN WITH GOOGLE
            </button>
          )}
        </div>
      </header>

      {currentTab === 'splitter' ? (
        <main className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Sidebar: Niches */}
        <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-zinc-800 bg-[#0d0d0d] p-4 md:p-6 flex flex-col gap-6 shrink-0 md:overflow-y-auto">
          <div>
            <label className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 font-bold mb-4 block">Style Preset</label>
            <nav className="flex flex-col gap-2">
              {(Object.keys(NICHES) as NicheKey[]).map((key) => {
                const niche = NICHES[key];
                const isSelected = selectedNiche === key;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedNiche(key)}
                    className={`flex items-center gap-3 w-full p-3 rounded-lg text-sm font-medium transition-colors ${
                      isSelected 
                        ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' 
                        : 'hover:bg-zinc-800 border-transparent border text-zinc-400'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${niche.dotColor}`}></span> 
                    {niche.label}
                  </button>
                )
              })}
            </nav>
          </div>

          <div className="mt-auto hidden md:block">
            <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
              <div className="flex justify-between items-end mb-3">
                <label className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 font-bold">Pacing Target</label>
                <span className="text-xs font-bold text-emerald-400">{wordsPerChunk} words/chunk</span>
              </div>
              <input 
                type="range" 
                min="15" 
                max="35" 
                value={wordsPerChunk}
                onChange={(e) => setWordsPerChunk(Number(e.target.value))}
                className="w-full accent-emerald-500 mb-2"
              />
              <div className="flex justify-between mt-2 text-[10px] text-zinc-500 font-medium">
                <span>Slow / Calm (15)</span>
                <span>Fast / Energetic (35)</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Workspace */}
        <section className="flex-1 flex flex-col bg-[#080808] p-4 md:p-8 gap-6 md:gap-8 overflow-hidden relative">
          
          {showHistory && (
             <div className="absolute inset-0 bg-[#080808] z-20 p-4 md:p-8 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between shrink-0 mb-6 border-b border-zinc-800 pb-4">
                  <h2 className="text-lg font-semibold text-zinc-200">Your Script History</h2>
                  <button onClick={() => setShowHistory(false)} className="text-zinc-400 hover:text-white text-sm">Close</button>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-4">
                  {history.length === 0 ? (
                    <div className="text-zinc-500 text-sm italic text-center mt-10">No history found. Generate some scripts first.</div>
                  ) : (
                    history.map((item) => (
                      <div key={item.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition-colors cursor-pointer"
                           onClick={() => {
                             setScript(item.scriptText);
                             setSelectedNiche(item.niche as NicheKey);
                             setChunks(item.chunks);
                             setShowHistory(false);
                           }}>
                        <div className="flex justify-between items-start mb-2">
                           <span className="text-emerald-400 text-xs font-bold uppercase tracking-wider">{NICHES[item.niche as NicheKey]?.label || item.niche}</span>
                           <span className="text-[10px] text-zinc-500">{item.createdAt ? new Date(item.createdAt.toMillis()).toLocaleString() : 'Just now'}</span>
                        </div>
                        <p className="text-sm text-zinc-300 line-clamp-2 leading-relaxed">{item.scriptText}</p>
                        <div className="mt-3 flex items-center gap-3 text-[10px] text-zinc-500 uppercase tracking-widest font-semibold">
                          <span>{item.wordCount} words</span>
                          <span>{item.chunks?.length || 0} chunks</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
             </div>
          )}

          {/* Input Section */}
          <div className="flex flex-col gap-3 shrink-0">
            <div className="flex justify-between items-end">
              <h2 className="text-sm font-semibold text-zinc-400">MASTER SCRIPT INPUT</h2>
              <span className="text-[10px] text-zinc-600">{wordCount} WORDS DETECTED</span>
            </div>
            <textarea
              className="w-full h-32 md:h-40 bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 text-sm text-zinc-300 focus:outline-none focus:border-zinc-600 resize-none custom-scrollbar"
              placeholder="Paste your full script here..."
              spellCheck="false"
              value={script}
              onChange={(e) => setScript(e.target.value)}
            />
            <div className="flex justify-end">
              <button 
                onClick={handleGenerate}
                disabled={!script.trim() || isSaving}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-white text-[10px] sm:text-xs font-bold px-6 py-3 rounded transition-colors w-full sm:w-auto uppercase tracking-widest shadow-[0_0_15px_rgba(16,185,129,0.15)]"
              >
                {isSaving ? "SAVING..." : "GENERATE CHUNKS"}
              </button>
            </div>
          </div>

          {/* Output Section: Chunks */}
          <div className="flex-1 flex flex-col gap-4 overflow-hidden">
            <div className="flex items-center justify-between shrink-0">
              <h2 className="text-sm font-semibold text-zinc-400 italic">GENERATED CHUNKS (8s OPTIMIZED)</h2>
              <div className="text-xs flex gap-4 text-zinc-500">
                <span>Parts: {chunks.length}</span>
                {chunks.length > 0 && <span className="hidden sm:inline">Avg: ~{(wordCount / chunks.length).toFixed(1)} words/part</span>}
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 flex-1 overflow-y-auto pr-2 custom-scrollbar pb-8">
              <AnimatePresence>
                {chunks.map((chunk, idx) => {
                  const promptText = generatePromptForChunk(chunk, idx);
                  const isCopied = copiedStates[idx];
                  
                  return (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      key={idx}
                      className={isCopied 
                        ? "bg-emerald-900/10 border border-emerald-500 rounded-xl p-5 flex flex-col justify-between ring-1 ring-emerald-500/30"
                        : "bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 flex flex-col justify-between"
                      }
                    >
                      <div className="space-y-3 mb-6">
                        <div className="flex justify-between items-start">
                          <span className={`text-xs font-bold ${isCopied ? 'text-emerald-400' : 'text-emerald-500'}`}>PART {idx + 1}</span>
                          <span className={`text-[10px] font-mono ${isCopied ? 'text-emerald-500/50' : 'text-zinc-500'}`}>08:00</span>
                        </div>
                        <p className={`text-[11px] leading-relaxed break-words whitespace-pre-wrap ${isCopied ? 'text-zinc-200' : 'text-zinc-300'}`}>
                          {promptText}
                        </p>
                      </div>
                      <button
                        onClick={() => handleCopy(promptText, idx)}
                        className={isCopied 
                          ? "w-full py-2 bg-emerald-500 text-black text-[10px] font-bold rounded uppercase tracking-widest shadow-[0_0_15px_rgba(16,185,129,0.3)] mt-auto"
                          : "w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-[10px] font-bold rounded uppercase tracking-widest transition-all mt-auto"
                        }
                      >
                        {isCopied ? "Copied to Clipboard" : "Copy Prompt"}
                      </button>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {chunks.length === 0 && (
                <div className="col-span-full h-full flex items-center justify-center text-zinc-600 text-sm italic">
                  Paste a script and click "SPLIT SCRIPT" to generate optimal 8s chunks.
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
      ) : (
        <main className="flex flex-col flex-1 overflow-hidden bg-[#080808] relative">
          {showStructures && (
             <div className="absolute inset-0 bg-[#080808] z-20 p-4 md:p-8 flex flex-col overflow-hidden max-w-5xl mx-auto w-full">
                <div className="flex items-center justify-between shrink-0 mb-6 border-b border-zinc-800 pb-4">
                  <h2 className="text-lg font-semibold text-zinc-200">Saved Strategies & Analyses</h2>
                  <button onClick={() => setShowStructures(false)} className="text-zinc-400 hover:text-white text-sm">Close</button>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-4">
                  {structures.length === 0 ? (
                    <div className="text-zinc-500 text-sm italic text-center mt-10">No saved strategies found.</div>
                  ) : (
                    structures.map((item) => (
                      <div key={item.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col md:flex-row gap-4 justify-between"
                           >
                        <div className="flex-1">
                          <div className="flex justify-between items-start mb-2">
                             <span className="text-emerald-400 text-xs font-bold uppercase tracking-wider">Formula Strategy</span>
                             <span className="text-[10px] text-zinc-500">{item.createdAt ? new Date(item.createdAt.toMillis()).toLocaleString() : 'Just now'}</span>
                          </div>
                          <p className="text-sm text-zinc-300 line-clamp-3 leading-relaxed mb-3">{item.analysisText}</p>
                          <div className="flex items-center gap-3 text-[10px] text-zinc-500 uppercase tracking-widest font-semibold">
                            <span>AVG Pacing: ~{item.avgWordCount} words/8s</span>
                          </div>
                        </div>
                        <div className="flex flex-col justify-center shrink-0">
                          <button 
                            onClick={() => openGenerator(item)}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-4 py-2 rounded transition-colors uppercase tracking-widest mt-2 md:mt-0 shadow-md shadow-emerald-500/10"
                          >
                            Script Generator
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
             </div>
          )}

          <div className="max-w-5xl w-full mx-auto p-4 md:p-8 flex flex-col h-full gap-6 overflow-hidden">
            <div className="flex flex-col gap-2 shrink-0">
              <h2 className="text-xl font-bold text-zinc-200">Ideation Lab</h2>
              <p className="text-sm text-zinc-500">Paste your competitor's viral transcripts below. Our AI will analyze their hooks, pacing, and retention formulas to generate 5 new video ideas tailored to out-perform them.</p>
            </div>

            <div className="flex flex-col md:flex-row gap-6 flex-1 overflow-hidden">
              <div className="flex flex-col gap-3 w-full md:w-1/3 shrink-0 h-1/2 md:h-full">
                <div className="flex justify-between items-end">
                  <h3 className="text-sm font-semibold text-zinc-400">COMPETITOR TRANSCRIPT</h3>
                </div>
                <textarea
                  className="w-full h-full bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 text-sm text-zinc-300 focus:outline-none focus:border-zinc-600 resize-none custom-scrollbar"
                  placeholder="Paste multiple viral transcripts here..."
                  spellCheck="false"
                  value={competitorTranscript}
                  onChange={(e) => setCompetitorTranscript(e.target.value)}
                />
                <button 
                  onClick={handleAnalyze}
                  disabled={!competitorTranscript.trim() || isAnalyzing}
                  className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-white text-[10px] sm:text-xs font-bold px-6 py-3 rounded transition-colors w-full uppercase tracking-widest shadow-[0_0_15px_rgba(16,185,129,0.15)] mt-1"
                >
                  {isAnalyzing ? "ANALYZING..." : "ANALYZE & GENERATE IDEAS"}
                </button>
              </div>

              <div className="flex flex-col gap-3 flex-1 h-1/2 md:h-full overflow-hidden">
                <div className="flex justify-between items-center shrink-0">
                  <h3 className="text-sm font-semibold text-zinc-400">ANALYSIS & NEW TOPICS</h3>
                  <div className="flex items-center gap-2">
                    {ideationResult && (
                      <button 
                        onClick={openGeneratorFromCurrent}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-3 py-1.5 rounded transition-colors uppercase tracking-widest"
                      >
                        Generate Clean Script
                      </button>
                    )}
                    {ideationResult && user && (
                      <button 
                        onClick={handleSaveStructure}
                        disabled={isSavingStructure}
                        className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-bold px-3 py-1.5 rounded transition-colors uppercase tracking-widest"
                      >
                        {isSavingStructure ? 'Saving...' : 'Save Strategy'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 bg-zinc-900/40 border border-zinc-800 rounded-xl p-6 overflow-y-auto custom-scrollbar">
                  {isAnalyzing ? (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-4">
                       <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin"></div>
                       <p className="text-sm font-medium animate-pulse">Running Post-Mortem Analysis & Ideating...</p>
                    </div>
                  ) : ideationResult ? (
                    <div className="prose prose-invert prose-emerald max-w-none prose-sm md:prose-base prose-p:leading-relaxed prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800 markdown-body">
                      <Markdown>{ideationResult}</Markdown>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-zinc-600 text-sm italic">
                      Results will appear here.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

