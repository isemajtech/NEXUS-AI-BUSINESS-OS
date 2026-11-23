import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import {
  Bot,
  Send,
  Plus,
  Trash2,
  Sparkles,
  ChevronDown,
  MessageSquare,
} from 'lucide-react';

export const AIAssistant: React.FC = () => {
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    chatMessages,
    createNewConversation,
    deleteConversation,
    sendMessageToAssistant,
    isAiThinking,
    supabaseConfig,
  } = useOS();

  const [inputMessage, setInputMessage] = useState('');
  const [isBriefingsDropdownOpen, setIsBriefingsDropdownOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeMessages = chatMessages.filter((m) => m.conversationId === activeConversationId);
  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  const promptSuggestions = [
    'Hello, introduce yourself as my Nexus AI Business OS assistant.',
    'Draft a pricing and launch strategy for a new developer micro-SaaS',
    'Audit our Row Level Security policies across all Supabase tables',
    'Formulate a 4-week email marketing sequence for new subscribers',
    'Evaluate operational expenses and identify recurring SaaS burn',
  ];

  // Auto-scroll to bottom of conversation
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeMessages.length, isAiThinking]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || isAiThinking) return;
    const msg = inputMessage.trim();
    setInputMessage('');
    await sendMessageToAssistant(msg);
  };

  const handleSuggestionClick = async (text: string) => {
    setInputMessage('');
    await sendMessageToAssistant(text);
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#07090e] text-slate-100 overflow-hidden relative">
      {/* Sleek Minimal Chat Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 bg-[#0a0d14] border-b border-[#182133] shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-md shadow-blue-500/20">
            <Bot className="w-5 h-5" />
            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${supabaseConfig.isConnected ? 'bg-emerald-400' : 'bg-amber-400'} ring-2 ring-[#0a0d14] animate-pulse`} />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
                AI Executive Assistant & Coordinator
              </h1>
              <span className="hidden sm:inline-flex px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                Gemini 2.5 Flash
              </span>
              <span
                className={`hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono ${
                  supabaseConfig.isConnected
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${supabaseConfig.isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                {supabaseConfig.isConnected ? 'Supabase Linked' : 'Supabase Offline'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Nexus OS Central Coordinator &bull; Strict Owner-Approval Governance
            </p>
          </div>
        </div>

        {/* Right side: Briefing Thread Selector + New Briefing Button */}
        <div className="flex items-center gap-2">
          {/* Briefings Dropdown */}
          <div className="relative">
            <button
              onClick={() => setIsBriefingsDropdownOpen(!isBriefingsDropdownOpen)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-[#121825] hover:bg-[#182030] text-slate-300 border border-[#202b3e] transition-colors"
              title="Switch Briefing Thread"
            >
              <MessageSquare className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span className="max-w-[100px] sm:max-w-[140px] truncate text-[11px]">
                {activeConversation?.title || 'Briefings'}
              </span>
              <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
            </button>

            {isBriefingsDropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setIsBriefingsDropdownOpen(false)}
                />
                <div className="absolute right-0 mt-1.5 w-64 rounded-xl bg-[#0f1420] border border-[#222e44] shadow-2xl z-50 py-1.5 animate-in fade-in zoom-in-95">
                  <div className="px-3 py-1.5 text-[10px] font-mono font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between border-b border-[#1b2537]">
                    <span>Saved Briefings</span>
                    <span className="text-slate-500">{conversations.length}</span>
                  </div>

                  <div className="max-h-56 overflow-y-auto py-1 space-y-0.5">
                    {conversations.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => {
                          setActiveConversationId(c.id);
                          setIsBriefingsDropdownOpen(false);
                        }}
                        className={`group flex items-center justify-between px-3 py-2 text-xs cursor-pointer transition-colors ${
                          activeConversationId === c.id
                            ? 'bg-blue-600/15 text-blue-300 font-semibold'
                            : 'text-slate-400 hover:bg-[#151c2c] hover:text-slate-200'
                        }`}
                      >
                        <span className="truncate pr-2">{c.title}</span>
                        {conversations.length > 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteConversation(c.id);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-rose-400 transition-opacity"
                            title="Delete Briefing"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="pt-1 border-t border-[#1b2537]">
                    <button
                      onClick={() => {
                        createNewConversation();
                        setIsBriefingsDropdownOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-[#151c2c] flex items-center gap-1.5 font-medium"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Start New Briefing
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* New Chat Button */}
          <button
            onClick={() => createNewConversation()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors shrink-0"
            title="Start New Briefing"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New Briefing</span>
          </button>
        </div>
      </header>

      {/* Main Conversation Stream */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="max-w-3xl mx-auto w-full space-y-5">
          {activeMessages.length === 0 ? (
            /* Clean Empty Welcome State */
            <div className="py-12 sm:py-20 flex flex-col items-center justify-center text-center space-y-4 animate-fade-in">
              <div className="relative p-4 rounded-2xl bg-gradient-to-br from-blue-600/10 to-violet-600/10 border border-blue-500/20 text-blue-400 shadow-xl shadow-blue-500/5">
                <Bot className="w-12 h-12 text-blue-400" />
                <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-emerald-400 ring-4 ring-[#07090e]" />
              </div>

              <div className="space-y-1.5 max-w-md">
                <h2 className="text-lg sm:text-xl font-bold text-slate-100 tracking-tight">
                  Nexus Executive Directive Console
                </h2>
                <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
                  Your sovereign central coordinator governing 6 specialized AI departments under strict Owner-Approval governance.
                </p>
              </div>

              {/* Quick suggestions pills inside empty state */}
              <div className="pt-4 flex flex-col w-full max-w-lg space-y-2 text-left">
                <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider text-center block mb-1">
                  Executive Quick Starters
                </span>
                {promptSuggestions.slice(0, 3).map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSuggestionClick(prompt)}
                    className="p-3 rounded-xl bg-[#0e131d] hover:bg-[#141b29] border border-[#1d273a] hover:border-blue-500/40 text-xs text-slate-300 hover:text-white transition-all flex items-center justify-between group"
                  >
                    <span>{prompt}</span>
                    <Sparkles className="w-3.5 h-3.5 text-blue-400 opacity-60 group-hover:opacity-100 transition-opacity shrink-0 ml-2" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Active Message List */
            activeMessages.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex gap-3 text-xs sm:text-sm leading-relaxed ${
                    isUser ? 'justify-end' : 'justify-start'
                  } animate-fade-in`}
                >
                  {!isUser && (
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center text-white shrink-0 mt-0.5 shadow-md shadow-blue-500/20">
                      <Bot className="w-4 h-4" />
                    </div>
                  )}

                  <div
                    className={`max-w-[88%] sm:max-w-[80%] p-4 rounded-2xl ${
                      isUser
                        ? 'bg-blue-600 text-white rounded-tr-xs shadow-md shadow-blue-600/20'
                        : msg.source === 'error_diagnostic'
                        ? 'bg-rose-950/25 text-rose-200 border border-rose-500/40 rounded-tl-xs whitespace-pre-wrap leading-relaxed shadow-lg'
                        : msg.isFallback
                        ? 'bg-[#14121b] text-amber-200/90 border border-amber-500/30 rounded-tl-xs whitespace-pre-wrap leading-relaxed shadow-lg'
                        : 'bg-[#0f1422] text-slate-200 border border-[#1e283d] rounded-tl-xs whitespace-pre-wrap leading-relaxed shadow-lg'
                    }`}
                  >
                    {!isUser && (
                      <div className="mb-2 pb-2 border-b border-white/10 flex items-center justify-between gap-2">
                        {msg.source === 'supabase_edge_function' && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            Live Gemini 2.5 Flash &bull; Supabase Edge Function
                          </span>
                        )}
                        {msg.source === 'server_gemini' && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-violet-500/15 text-violet-300 border border-violet-500/30">
                            <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                            Live Gemini 2.5 Flash &bull; Server Proxy
                          </span>
                        )}
                        {msg.source === 'error_diagnostic' && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                            Diagnostic: Edge Function Invocation Error
                          </span>
                        )}
                        {msg.isFallback && msg.source !== 'error_diagnostic' && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                            Offline Fallback Simulation (No Live API)
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-slate-400 ml-auto">
                          {new Date(msg.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    )}

                    <div className="text-xs sm:text-sm">{msg.content}</div>

                    {isUser && (
                      <div className="mt-2 text-[10px] font-mono text-blue-200 text-right">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {/* AI Thinking Animation */}
          {isAiThinking && (
            <div className="flex gap-3 text-xs sm:text-sm animate-fade-in">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center text-white shrink-0 shadow-md">
                <Bot className="w-4 h-4 animate-spin" />
              </div>
              <div className="p-4 rounded-2xl bg-[#0f1422] text-slate-300 border border-[#1e283d] rounded-tl-xs flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" />
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce delay-100" />
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce delay-200" />
                <span className="text-xs text-slate-400 font-mono">Formulating executive directive with Gemini 2.5 Flash...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Floating / Docked Bottom Input Area */}
      <div className="border-t border-[#172031] bg-[#0a0d15]/95 backdrop-blur-md pb-16 sm:pb-16 pt-2 px-3 sm:px-6 shrink-0 z-20">
        <div className="max-w-3xl mx-auto w-full space-y-2">
          {/* Quick suggestions pills */}
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5">
            {promptSuggestions.map((sug, idx) => (
              <button
                key={idx}
                onClick={() => handleSuggestionClick(sug)}
                disabled={isAiThinking}
                className="px-3 py-1 text-[11px] rounded-full bg-[#121724] hover:bg-[#1a2336] text-slate-400 hover:text-slate-100 border border-[#1e293f] shrink-0 transition-colors disabled:opacity-40"
              >
                {sug}
              </button>
            ))}
          </div>

          {/* Input Form */}
          <form onSubmit={handleSend} className="flex gap-2 items-center">
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder="Instruct the Executive Coordinator or dispatch a multi-agent objective..."
              disabled={isAiThinking}
              className="flex-1 px-4 py-2.5 text-xs sm:text-sm rounded-xl bg-[#121724] border border-[#202b3f] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
            <button
              type="submit"
              disabled={!inputMessage.trim() || isAiThinking}
              className="px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center gap-1.5 shrink-0"
            >
              <span className="hidden sm:inline">Send</span>
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
