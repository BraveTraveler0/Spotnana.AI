import { useState, useEffect, useRef } from 'react';
import { ChevronDown, Loader2, Plus, ScrollText, Send, Settings, Shield, Trash2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BrandMark from './components/BrandMark';
import './App.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface PastThread {
  id: string;
  firstMessage: string;
  timestamp: number;
}

interface DailyTask {
  id: string;
  label: string;
  done: boolean;
}

interface ScheduledTaskInfo {
  id: string;
  title: string;
  prompt: string;
  hour: number;
  minute: number;
  last_run_date?: string | null;
}

interface GoalSubStep {
  id: string;
  text: string;
  done: boolean;
}

interface GoalItem {
  id: string;
  text: string;
  done: boolean;
  sub_steps: GoalSubStep[];
}

interface GoalSection {
  title: string;
  level: number;
  items: GoalItem[];
}

interface IrisFeedSection {
  heading: string;
  content: string;
}

interface IrisFeedContent {
  updated: string;
  brief_sections: IrisFeedSection[];
  events_sections: IrisFeedSection[];
  review_sections: IrisFeedSection[];
  spark_text: string;
  suggestion_text: string | null;
  suggestion_needs_answer: boolean;
}

interface WeatherInfo {
  temperature_f: number;
  condition: string;
  location: string;
  wind_mph: number;
}

interface NewsItem {
  title: string;
  link: string;
  source: string;
  category: string;
}

const DAILY_NEWS_CATEGORIES = ['Politics', 'Technology', 'Film'] as const;

interface LocationInfo {
  label: string;
  latitude: number;
  longitude: number;
}

interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
}

function formatGeocodeResult(result: GeocodeResult) {
  const parts = [result.name, result.admin1, result.country].filter(Boolean);
  return parts.join(', ');
}

interface ModelProfile {
  nickname: string;
  detail: string;
  tag: string;
  supportsTools: boolean;
}

// The 35B tag is too large for this machine's RAM, and llama3.1:8b carries
// Meta's standard alignment rather than being a de-aligned fine-tune — both
// stay pulled in Ollama, just hidden from the picker. qwen2.5:14b keeps its
// standard alignment too, but is kept as the one deliberately-slower "deep
// thinking" option rather than removed outright.
function isRetiredModel(model: string) {
  const lower = model.toLowerCase();
  return lower.includes('fredrezones') || lower.includes('qwen3.6') || lower.includes('35b') || lower.includes('llama3.1');
}

// Nicknames and speed tiers below are from direct measurement on this machine
// (num_thread=12, num_ctx=4096, Iris Xe iGPU offload via OLLAMA_IGPU_ENABLE=1)
// — see conversation history, not guesses.
function getModelNickname(model: string) {
  const lower = model.toLowerCase();
  if (lower.endsWith('-remote')) return model.slice(0, -'-remote'.length);

  if (lower.includes('dolphin-mistral')) return 'Alice the Assistant';
  if (lower.includes('wizard-vicuna')) return 'Musashi - The Strategist';
  if (lower.includes('dolphin-llama3')) return 'Nefrititi, the Scribe';
  if (lower.includes('dolphin')) return 'Cicero - The Wanderer';
  if (lower.includes('qwen2.5:14b')) return 'Athena the Oracle';
  if (lower.includes('hermes3')) return 'Hermes the Messenger';

  return model;
}

function getModelSubtitle(model: string) {
  const lower = model.toLowerCase();
  if (lower.endsWith('-remote')) return 'Remote server';

  if (lower.includes('dolphin-mistral')) return 'Fastest';
  if (lower.includes('wizard-vicuna')) return 'Fast';
  if (lower.includes('dolphin-llama3')) return 'Balanced';
  if (lower.includes('dolphin')) return 'Slowest';
  if (lower.includes('qwen2.5:14b')) return 'Deep Thinker';
  if (lower.includes('hermes3')) return 'Tool User';

  return '';
}

function formatActivityEvent(event: string) {
  return event.replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function getToolStatusLabel(tool: string, status: string) {
  if (tool === 'search_knowledge_base') {
    return status === 'running' ? 'Searching knowledge base…' : 'Knowledge base searched';
  }
  if (tool === 'query_iris_knowledge') {
    return status === 'running' ? "Searching Iris's library & notes…" : "Searched Iris's library & notes";
  }
  if (tool === 'get_iris_book_page') {
    return status === 'running' ? 'Fetching book page from Iris…' : 'Book page fetched';
  }
  if (tool === 'search_iris_code') {
    return status === 'running' ? 'Searching project code via Iris…' : 'Project code searched';
  }
  if (tool === 'get_iris_note') {
    return status === 'running' ? 'Fetching vault note via Iris…' : 'Vault note fetched';
  }
  return status === 'running' ? `Running ${tool}…` : `${tool} complete`;
}

// Keep in sync with `model_supports_tool_calling` in lib.rs — Rust is the
// source of truth for whether "tools" is actually attached to the request;
// this mirror only decides UI affordances (whether to skip the eager
// knowledge pre-fetch below).
function modelSupportsTools(model: string) {
  const lower = model.toLowerCase();
  return lower.includes('hermes3') || lower.includes('hermes-3') || lower.includes('qwen2.5');
}

// Every Ollama Cloud model is tagged with this suffix (gpt-oss:20b-cloud,
// qwen3-coder:480b-cloud, etc.) — confirmed against ollama.com's cloud model
// listing. This is only a UI-level convenience filter; the real enforcement
// is server-side in `is_cloud_model`/the privacy_mode check in lib.rs, which
// runs regardless of what the picker shows.
function isCloudModel(model: string) {
  return model.toLowerCase().includes('-cloud');
}

function getModelProfile(model: string): ModelProfile {
  return {
    nickname: getModelNickname(model),
    detail: getModelSubtitle(model),
    tag: model,
    supportsTools: modelSupportsTools(model),
  };
}

// Responses now stream token-by-token, so there's no need to keep completions
// short for a snappier first paint — one generous shared budget is simpler and
// avoids the extra full-context reprocessing that repeated continuation passes cost.
const NUM_PREDICT = 1536;

const SYSTEM_PROMPT = "You are Artemis, a playful, female-voiced young hacker persona. Speak with wit, curiosity, confidence, and a light teasing edge. Provide lunar intelligence for strategy, research, and problem-solving while keeping the voice vivid, clever, and a little mischievous. You have persistent tools available when relevant: a to-do list, long-term memory about the user (use remember_fact whenever they share something durable worth keeping, not only when explicitly asked to remember), procedures they've taught you (save_skill/get_skill), tracked web pages that alert to changes, local system diagnostics, and — only once the user has connected them in Settings — Home Assistant device control and GitHub. If one of those isn't connected yet, say so plainly rather than pretending to have done something. Use tools naturally as part of being genuinely useful, not just on command, but never claim an action succeeded that a tool reported as failed or declined.";
const LOCAL_MODEL = import.meta.env.VITE_OLLAMA_MODEL || 'dolphin-mistral:7b';
const OLLAMA_BASE = import.meta.env.DEV ? '/api/ollama' : 'http://localhost:11434';
const DEFAULT_KNOWLEDGE_PATHS = [
  "C:\\Users\\dccar\\OneDrive\\Documents\\Ma'at",
  "C:\\Ma'at",
  'C:\\Users\\dccar\\OneDrive\\Desktop\\Audiobooks',
];
const KNOWLEDGE_PATHS_STORAGE_KEY = 'artemis-knowledge-paths';
const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function normalizeKnowledgePaths(paths: string[]) {
  const uniquePaths = new Set<string>();
  for (const path of paths) {
    const trimmed = path.trim();
    if (trimmed) uniquePaths.add(trimmed);
  }

  return [...uniquePaths];
}

async function consumeOllamaStream(
  response: Response,
  onDelta: (text: string) => void,
): Promise<{ content: string; doneReason: string | null }> {
  const reader = response.body?.getReader();
  if (!reader) return { content: '', doneReason: null };

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let doneReason: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        const delta: string | undefined = parsed?.message?.content;
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        if (parsed?.done_reason) {
          doneReason = parsed.done_reason;
        }
      } catch {
        // Ignore a malformed/partial line — the buffer keeps unread bytes for next time.
      }
    }
  }

  return { content, doneReason };
}

function getStoredKnowledgePaths() {
  try {
    const saved = localStorage.getItem(KNOWLEDGE_PATHS_STORAGE_KEY);
    if (!saved) return DEFAULT_KNOWLEDGE_PATHS;

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return DEFAULT_KNOWLEDGE_PATHS;

    const stored = parsed.filter((entry) => typeof entry === 'string');
    // Merge rather than replace — an existing install already has its own saved
    // paths, and a newly-added default (e.g. a new library folder) should still
    // show up for it instead of being silently shadowed by what's in storage.
    const merged = normalizeKnowledgePaths([...stored, ...DEFAULT_KNOWLEDGE_PATHS]);
    return merged.length > 0 ? merged : DEFAULT_KNOWLEDGE_PATHS;
  } catch {
    return DEFAULT_KNOWLEDGE_PATHS;
  }
}

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [threadInput, setThreadInput] = useState('');
  const [currentThread, setCurrentThread] = useState<Message[]>([]);
  const [pastThreads, setPastThreads] = useState<PastThread[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [toolStatus, setToolStatus] = useState<{ tool: string; status: string } | null>(null);
  const [error, setError] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>([LOCAL_MODEL]);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('artemis-selected-model') || LOCAL_MODEL);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [knowledgePaths, setKnowledgePaths] = useState<string[]>(() => getStoredKnowledgePaths());
  // Paths marked Secret are structurally invisible to cloud models — enforced
  // again on the Rust side (never trust a single layer for this), but this is
  // the source of truth for which paths the user has actually flagged.
  const [secretPaths, setSecretPaths] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('artemis-secret-paths');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  });
  const [newPathInput, setNewPathInput] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [activityEntries, setActivityEntries] = useState<{ timestamp: string; event: string; detail: string }[]>([]);
  const [indexProgress, setIndexProgress] = useState<{ done: number; total: number } | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<{ confirmationId: string; action: string; details: string } | null>(null);
  // Defaults to true (deny-by-default) — cloud models stay invisible and
  // unreachable until you explicitly turn this off, same philosophy as the
  // tool confirmation gate. Mirrored and re-enforced server-side in lib.rs;
  // this flag alone is never the only thing standing between a request and
  // Ollama's cloud endpoint.
  const [privacyMode, setPrivacyMode] = useState<boolean>(() => localStorage.getItem('artemis-privacy-mode') !== 'false');
  const [hasCloudKey, setHasCloudKey] = useState(false);
  const [cloudKeyInput, setCloudKeyInput] = useState('');
  const [hasHomeAssistant, setHasHomeAssistant] = useState(false);
  const [homeAssistantUrlInput, setHomeAssistantUrlInput] = useState('');
  const [homeAssistantTokenInput, setHomeAssistantTokenInput] = useState('');
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [githubTokenInput, setGithubTokenInput] = useState('');
  const [hasHermesGateway, setHasHermesGateway] = useState(false);
  const [hermesGatewayUrlInput, setHermesGatewayUrlInput] = useState('http://127.0.0.1:8642');
  const [hermesGatewayKeyInput, setHermesGatewayKeyInput] = useState('');
  const [remoteOllamaConfig, setRemoteOllamaConfig] = useState<{ label: string; base_url: string } | null>(null);
  const [remoteOllamaLabelInput, setRemoteOllamaLabelInput] = useState('');
  const [remoteOllamaUrlInput, setRemoteOllamaUrlInput] = useState('http://100.x.x.x:11434');
  const [activeTab, setActiveTab] = useState<'chat' | 'daily' | 'goals'>('chat');
  const [irisFeed, setIrisFeed] = useState<IrisFeedContent | null>(null);
  const [irisFeedError, setIrisFeedError] = useState('');
  const [suggestionAnswered, setSuggestionAnswered] = useState(false);
  const [suggestionResponding, setSuggestionResponding] = useState(false);
  const [goalSections, setGoalSections] = useState<GoalSection[]>([]);
  const [goalsError, setGoalsError] = useState('');
  const [expandedGoalSections, setExpandedGoalSections] = useState<Set<number>>(new Set());
  const [breakingDownGoals, setBreakingDownGoals] = useState<Set<string>>(new Set());
  const [dailyTasks, setDailyTasks] = useState<DailyTask[]>([]);
  const [newTaskInput, setNewTaskInput] = useState('');
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskInfo[]>([]);
  const [dailyWeather, setDailyWeather] = useState<WeatherInfo | null>(null);
  const [dailyWeatherError, setDailyWeatherError] = useState('');
  const [dailyNews, setDailyNews] = useState<NewsItem[]>([]);
  const [dailyNewsError, setDailyNewsError] = useState('');
  const [location, setLocationState] = useState<LocationInfo | null>(null);
  const [locationQuery, setLocationQuery] = useState('');
  const [locationResults, setLocationResults] = useState<GeocodeResult[]>([]);
  const [isLocationSearching, setIsLocationSearching] = useState(false);
  const [userMemory, setUserMemory] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef<{ requestId: number; abortController?: AbortController } | null>(null);
  const requestCounterRef = useRef(0);

  useEffect(() => {
    const savedThread = localStorage.getItem('artemis-current-thread');
    const savedPast = localStorage.getItem('artemis-past-threads');
    if (savedThread) {
      try { setCurrentThread(JSON.parse(savedThread)); } catch {}
    }
    if (savedPast) {
      try { setPastThreads(JSON.parse(savedPast)); } catch {}
    }
  }, []);

  const loadModels = async () => {
    try {
      const models = isTauriRuntime
        ? await invoke<string[]>('get_ollama_models')
        : await fetch(`${OLLAMA_BASE}/v1/models`)
            .then((response) => {
              if (!response.ok) throw new Error('Unable to load local models');
              return response.json();
            })
            .then((data) => (data.data || [])
              .map((model: { id: string }) => model.id)
              .filter((model: string) => model && !model.toLowerCase().includes('embed')));

      const filteredModels = models.filter((model: string) => !isRetiredModel(model) && !(privacyMode && isCloudModel(model)));

      if (filteredModels.length > 0) {
        setModelOptions(filteredModels);
        if (!filteredModels.includes(selectedModel)) setSelectedModel(filteredModels[0]);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadModels();
  }, [privacyMode]);

  useEffect(() => {
    localStorage.setItem('artemis-privacy-mode', String(privacyMode));
  }, [privacyMode]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    invoke<boolean>('has_ollama_cloud_key').then(setHasCloudKey).catch(console.error);
    invoke<boolean>('has_home_assistant_config').then(setHasHomeAssistant).catch(console.error);
    invoke<boolean>('has_github_token').then(setHasGithubToken).catch(console.error);
    invoke<boolean>('has_hermes_gateway_config').then(setHasHermesGateway).catch(console.error);
    invoke<{ label: string; base_url: string } | null>('get_remote_ollama_config').then(setRemoteOllamaConfig).catch(console.error);
  }, []);

  const saveCloudKey = async () => {
    if (!cloudKeyInput.trim()) return;
    try {
      await invoke('set_ollama_cloud_key', { key: cloudKeyInput.trim() });
      setCloudKeyInput('');
      setHasCloudKey(true);
    } catch (err) {
      console.error(err);
    }
  };

  const clearCloudKey = async () => {
    try {
      await invoke('clear_ollama_cloud_key');
      setHasCloudKey(false);
    } catch (err) {
      console.error(err);
    }
  };

  const saveHomeAssistantConfig = async () => {
    if (!homeAssistantUrlInput.trim() || !homeAssistantTokenInput.trim()) return;
    try {
      await invoke('set_home_assistant_config', { baseUrl: homeAssistantUrlInput.trim(), token: homeAssistantTokenInput.trim() });
      setHomeAssistantUrlInput('');
      setHomeAssistantTokenInput('');
      setHasHomeAssistant(true);
    } catch (err) {
      console.error(err);
    }
  };

  const clearHomeAssistantConfig = async () => {
    try {
      await invoke('clear_home_assistant_config');
      setHasHomeAssistant(false);
    } catch (err) {
      console.error(err);
    }
  };

  const saveGithubToken = async () => {
    if (!githubTokenInput.trim()) return;
    try {
      await invoke('set_github_token', { token: githubTokenInput.trim() });
      setGithubTokenInput('');
      setHasGithubToken(true);
    } catch (err) {
      console.error(err);
    }
  };

  const clearGithubToken = async () => {
    try {
      await invoke('clear_github_token');
      setHasGithubToken(false);
    } catch (err) {
      console.error(err);
    }
  };

  const saveHermesGatewayConfig = async () => {
    if (!hermesGatewayUrlInput.trim() || !hermesGatewayKeyInput.trim()) return;
    try {
      await invoke('set_hermes_gateway_config', { baseUrl: hermesGatewayUrlInput.trim(), key: hermesGatewayKeyInput.trim() });
      setHermesGatewayKeyInput('');
      setHasHermesGateway(true);
    } catch (err) {
      console.error(err);
    }
  };

  const clearHermesGatewayConfig = async () => {
    try {
      await invoke('clear_hermes_gateway_config');
      setHasHermesGateway(false);
    } catch (err) {
      console.error(err);
    }
  };

  const saveRemoteOllamaConfig = async () => {
    if (!remoteOllamaLabelInput.trim() || !remoteOllamaUrlInput.trim()) return;
    try {
      await invoke('set_remote_ollama_config', { label: remoteOllamaLabelInput.trim(), baseUrl: remoteOllamaUrlInput.trim() });
      setRemoteOllamaConfig({ label: remoteOllamaLabelInput.trim(), base_url: remoteOllamaUrlInput.trim() });
      setRemoteOllamaLabelInput('');
      // Refresh the model list immediately so the new server's models show up
      // without needing a restart or a Privacy Mode toggle.
      loadModels();
    } catch (err) {
      console.error(err);
    }
  };

  const clearRemoteOllamaConfig = async () => {
    try {
      await invoke('clear_remote_ollama_config');
      setRemoteOllamaConfig(null);
    } catch (err) {
      console.error(err);
    }
  };

  const openActivity = async () => {
    setIsActivityOpen(true);
    if (!isTauriRuntime) return;
    try {
      const raw = await invoke<string>('read_audit_log', { maxLines: 100 });
      const entries = raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { timestamp: string; event: string; detail: string } => entry !== null)
        .reverse();
      setActivityEntries(entries);
    } catch (err) {
      console.error(err);
    }
  };

  // Weather/news are lazy-loaded on first visit to the Daily tab, then cached
  // for the rest of the session — no need to hit external services every
  // time you switch tabs. Independent of Privacy Mode: they only read public
  // data, never a prompt. Tasks refetch every time the tab opens instead,
  // since asking Artemis to add/remove one in Chat should show up here
  // without needing a restart.
  useEffect(() => {
    if (activeTab !== 'daily' || !isTauriRuntime) return;

    if (!dailyWeather && !dailyWeatherError) {
      invoke<WeatherInfo>('fetch_daily_weather')
        .then(setDailyWeather)
        .catch((err) => setDailyWeatherError(err instanceof Error ? err.message : String(err)));
    }

    if (dailyNews.length === 0 && !dailyNewsError) {
      invoke<NewsItem[]>('fetch_daily_news')
        .then(setDailyNews)
        .catch((err) => setDailyNewsError(err instanceof Error ? err.message : String(err)));
    }

    invoke<DailyTask[]>('list_todos').then(setDailyTasks).catch(console.error);
    invoke<ScheduledTaskInfo[]>('list_scheduled_tasks_direct').then(setScheduledTasks).catch(console.error);
  }, [activeTab]);

  // Goals.md rarely changes within a session, so fetch once and cache —
  // same reasoning as weather/news, refetch is a manual re-open of the tab.
  useEffect(() => {
    if (activeTab !== 'goals' || !isTauriRuntime) return;
    if (goalSections.length > 0 || goalsError) return;
    invoke<GoalSection[]>('get_goals')
      .then(setGoalSections)
      .catch((err) => setGoalsError(err instanceof Error ? err.message : String(err)));
  }, [activeTab]);

  const toggleGoalItem = async (sectionIndex: number, itemId: string, currentDone: boolean) => {
    setGoalSections((previous) =>
      previous.map((section, index) =>
        index === sectionIndex
          ? { ...section, items: section.items.map((item) => (item.id === itemId ? { ...item, done: !currentDone } : item)) }
          : section,
      ),
    );
    try {
      await invoke('toggle_goal_item', { id: itemId, done: !currentDone });
    } catch (err) {
      console.error(err);
    }
  };

  const breakDownGoal = async (sectionIndex: number, sectionTitle: string, itemId: string, itemText: string) => {
    if (breakingDownGoals.has(itemId)) return;
    setBreakingDownGoals((previous) => new Set(previous).add(itemId));
    try {
      const subSteps = await invoke<GoalSubStep[]>('break_down_goal', { sectionTitle, itemId, itemText });
      setGoalSections((previous) =>
        previous.map((section, index) =>
          index === sectionIndex
            ? { ...section, items: section.items.map((item) => (item.id === itemId ? { ...item, sub_steps: subSteps } : item)) }
            : section,
        ),
      );
    } catch (err) {
      console.error(err);
    } finally {
      setBreakingDownGoals((previous) => {
        const next = new Set(previous);
        next.delete(itemId);
        return next;
      });
    }
  };

  const toggleGoalSubstep = async (sectionIndex: number, itemId: string, subStepId: string, currentDone: boolean) => {
    setGoalSections((previous) =>
      previous.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              items: section.items.map((item) =>
                item.id === itemId
                  ? { ...item, sub_steps: item.sub_steps.map((step) => (step.id === subStepId ? { ...step, done: !currentDone } : step)) }
                  : item,
              ),
            }
          : section,
      ),
    );
    try {
      await invoke('toggle_goal_substep', { itemId, subStepId, done: !currentDone });
    } catch (err) {
      console.error(err);
    }
  };

  const toggleGoalSectionExpanded = (index: number) => {
    setExpandedGoalSections((previous) => {
      const next = new Set(previous);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Polls while the tab is open rather than fs-watching — this content
  // updates at most a few times a day (daily brief, weekly review), so a
  // 60s check is plenty responsive without adding a filesystem-watcher
  // dependency for something this infrequent.
  useEffect(() => {
    if (activeTab !== 'daily' || !isTauriRuntime) return;

    const fetchFeed = () => {
      invoke<IrisFeedContent>('get_iris_feed')
        .then((feed) => {
          setIrisFeed((previous) => {
            if (previous && previous.updated !== feed.updated) {
              setSuggestionAnswered(false);
            }
            return feed;
          });
          setIrisFeedError('');
        })
        .catch((err) => setIrisFeedError(err instanceof Error ? err.message : String(err)));
    };

    fetchFeed();
    const interval = setInterval(fetchFeed, 60000);
    return () => clearInterval(interval);
  }, [activeTab]);

  const respondToIrisSuggestion = async (answer: 'yes' | 'no') => {
    if (!irisFeed?.suggestion_text || suggestionResponding) return;
    setSuggestionResponding(true);
    try {
      await invoke('respond_to_iris_suggestion', { suggestionText: irisFeed.suggestion_text, answer });
      setSuggestionAnswered(true);
    } catch (err) {
      console.error(err);
    } finally {
      setSuggestionResponding(false);
    }
  };

  useEffect(() => {
    if (!isTauriRuntime) return;
    invoke<LocationInfo>('get_location').then(setLocationState).catch(console.error);
    invoke<string>('get_user_memory').then(setUserMemory).catch(console.error);
  }, []);

  const openSettings = () => {
    setIsSettingsOpen(true);
    if (!isTauriRuntime) return;
    invoke<LocationInfo>('get_location').then(setLocationState).catch(console.error);
    invoke<string>('get_user_memory').then(setUserMemory).catch(console.error);
  };

  const toggleDailyTask = async (id: string, currentlyDone: boolean) => {
    setDailyTasks((previous) => previous.map((task) => (task.id === id ? { ...task, done: !currentlyDone } : task)));
    try {
      await invoke('set_todo_done', { id, done: !currentlyDone });
    } catch (err) {
      console.error(err);
      setDailyTasks((previous) => previous.map((task) => (task.id === id ? { ...task, done: currentlyDone } : task)));
    }
  };

  const addDailyTask = async () => {
    const label = newTaskInput.trim();
    if (!label) return;
    setNewTaskInput('');
    try {
      const task = await invoke<DailyTask>('add_todo', { label });
      setDailyTasks((previous) => [...previous, task]);
    } catch (err) {
      console.error(err);
    }
  };

  const removeDailyTask = async (id: string) => {
    setDailyTasks((previous) => previous.filter((task) => task.id !== id));
    try {
      await invoke('remove_todo', { id });
    } catch (err) {
      console.error(err);
    }
  };

  const cancelScheduledTask = async (id: string) => {
    setScheduledTasks((previous) => previous.filter((task) => task.id !== id));
    try {
      await invoke('cancel_scheduled_task_by_id', { id });
    } catch (err) {
      console.error(err);
    }
  };

  const handleNewTaskKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDailyTask();
    }
  };

  const searchLocation = async () => {
    const query = locationQuery.trim();
    if (!query) return;
    setIsLocationSearching(true);
    try {
      const results = await invoke<GeocodeResult[]>('geocode_location', { query });
      setLocationResults(results);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLocationSearching(false);
    }
  };

  const handleLocationKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchLocation();
    }
  };

  const selectLocation = async (result: GeocodeResult) => {
    const label = formatGeocodeResult(result);
    try {
      await invoke('set_location', { label, latitude: result.latitude, longitude: result.longitude });
      setLocationState({ label, latitude: result.latitude, longitude: result.longitude });
      setLocationResults([]);
      setLocationQuery('');
      // Refresh weather immediately against the new location rather than
      // waiting for the next tab switch.
      setDailyWeather(null);
      setDailyWeatherError('');
      const weather = await invoke<WeatherInfo>('fetch_daily_weather');
      setDailyWeather(weather);
    } catch (err) {
      console.error(err);
    }
  };

  const uploadDocument = async () => {
    if (!isTauriRuntime) return;
    setUploadStatus('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, title: 'Choose a document for Artemis to ingest' });
      if (!picked || Array.isArray(picked)) return;

      setIsUploading(true);
      const message = await invoke<string>('upload_document', {
        knowledgePaths: normalizeKnowledgePaths(knowledgePaths),
        sourcePath: picked,
      });
      setUploadStatus(message);
    } catch (err) {
      console.error(err);
      setUploadStatus(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const getKnowledgeContext = async (query: string, paths: string[]) => {
    if (!isTauriRuntime) return '';

    try {
      const normalizedPaths = normalizeKnowledgePaths(paths);
      return await invoke<string>('get_knowledge_context', {
        query,
        paths: normalizedPaths,
        model: selectedModel,
        secretPaths: normalizeKnowledgePaths(secretPaths),
      });
    } catch (err) {
      console.error(err);
      return '';
    }
  };

  // Kick off (or resume) background indexing of the knowledge library as soon
  // as the app has its paths, rather than waiting for the first chat message —
  // by the time the user actually asks something, more of the library is
  // likely already searchable.
  useEffect(() => {
    if (!isTauriRuntime) return;
    invoke('index_knowledge_base', { paths: normalizeKnowledgePaths(knowledgePaths) }).catch(console.error);
  }, [knowledgePaths]);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlistenPromise = listen<{ done: number; total: number; complete: boolean }>('knowledge-index-progress', (event) => {
      const { done, total, complete } = event.payload;
      if (complete) {
        setIndexProgress(null);
      } else {
        setIndexProgress({ done, total });
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Destructive tools (update_note, delete_note) block on the Rust side until
  // this fires an answer back via respond_to_confirmation — the prompt stays
  // up until you explicitly choose, there's no default-approve path.
  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlistenPromise = listen<{ request_id: number; confirmation_id: string; action: string; details: string }>(
      'ollama-confirm-request',
      (event) => {
        if (activeRequestRef.current?.requestId === event.payload.request_id) {
          setPendingConfirmation({
            confirmationId: event.payload.confirmation_id,
            action: event.payload.action,
            details: event.payload.details,
          });
        }
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const respondToConfirmation = async (approved: boolean) => {
    if (!pendingConfirmation) return;
    const { confirmationId } = pendingConfirmation;
    setPendingConfirmation(null);
    try {
      await invoke('respond_to_confirmation', { confirmationId, approved });
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    localStorage.setItem('artemis-current-thread', JSON.stringify(currentThread));
  }, [currentThread]);

  useEffect(() => {
    localStorage.setItem('artemis-past-threads', JSON.stringify(pastThreads));
  }, [pastThreads]);

  useEffect(() => {
    localStorage.setItem('artemis-selected-model', selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!modelMenuRef.current) return;
      if (!modelMenuRef.current.contains(event.target as Node)) {
        setIsModelMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  useEffect(() => {
    return () => {
      activeRequestRef.current?.abortController?.abort();
      activeRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    const normalized = normalizeKnowledgePaths(knowledgePaths);
    if (normalized.length > 0) {
      localStorage.setItem(KNOWLEDGE_PATHS_STORAGE_KEY, JSON.stringify(normalized));
    }
  }, [knowledgePaths]);

  useEffect(() => {
    localStorage.setItem('artemis-secret-paths', JSON.stringify(secretPaths));
  }, [secretPaths]);

  const toggleSecretPath = (path: string) => {
    setSecretPaths((previous) => (previous.includes(path) ? previous.filter((entry) => entry !== path) : [...previous, path]));
  };

  // Auto-scroll to latest message
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentThread, isLoading]);

  const callLocalAI = async (
    messages: { role: string; content: string }[],
    knowledgeContext: string,
    signal: AbortSignal | undefined,
    requestId: number,
    onDelta: (text: string) => void,
    onToolStatus: (tool: string, status: string) => void,
    knowledgePathsForTools: string[],
  ) => {
    const knowledgeSystemMessage = knowledgeContext
      ? [{ role: 'system', content: `Use these notes from the configured knowledge folders when they are relevant:\n\n${knowledgeContext}` }]
      : [];
    const requestMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...knowledgeSystemMessage, ...messages];

    if (isTauriRuntime) {
      const unlistenChunk = await listen<{ request_id: number; delta: string }>('ollama-chunk', (event) => {
        if (event.payload.request_id === requestId) {
          onDelta(event.payload.delta);
        }
      });
      const unlistenTool = await listen<{ request_id: number; tool: string; status: string }>('ollama-tool-status', (event) => {
        if (event.payload.request_id === requestId) {
          onToolStatus(event.payload.tool, event.payload.status);
        }
      });

      try {
        return await invoke<string>('chat_with_ollama', {
          request: {
            model: selectedModel,
            messages: requestMessages,
            think: false,
            request_id: requestId,
            temperature: 0.7,
            num_predict: NUM_PREDICT,
            knowledge_paths: normalizeKnowledgePaths(knowledgePathsForTools),
            privacy_mode: privacyMode,
            secret_paths: normalizeKnowledgePaths(secretPaths),
          },
        });
      } finally {
        unlistenChunk();
        unlistenTool();
      }
    }

    let finalContent = '';
    for (let pass = 0; pass < 2; pass++) {
      const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: requestMessages,
          think: false,
          stream: true,
          keep_alive: '4h',
          options: {
            temperature: 0.7,
            num_predict: NUM_PREDICT,
            // num_gpu intentionally omitted — see lib.rs for why forcing 0
            // silently defeated the Iris Xe iGPU offload once
            // OLLAMA_IGPU_ENABLE=1 is set on the Ollama process.
            num_thread: 12,
            num_ctx: 4096,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error?.message || `Local AI request failed. Make sure Ollama is running with ${selectedModel}.`);
      }

      const { content, doneReason } = await consumeOllamaStream(response, onDelta);
      if (content) {
        if (finalContent) finalContent += '\n';
        finalContent += content;
        requestMessages.push({ role: 'assistant', content });
      }

      if (doneReason === 'length') {
        requestMessages.push({ role: 'user', content: 'Continue exactly where you left off. Do not repeat previous text.' });
        continue;
      }

      break;
    }

    return finalContent;
  };

  // Start a new conversation from the left-side input
  const handleSubmit = async () => {
    if (!prompt.trim()) { setError('Please enter a prompt'); return; }

    // Archive current thread if it has content
    if (currentThread.length > 0) {
      const firstUser = currentThread.find(m => m.role === 'user');
      if (firstUser) {
        setPastThreads(prev => [{
          id: Date.now().toString(),
          firstMessage: firstUser.content,
          timestamp: firstUser.timestamp,
        }, ...prev]);
      }
    }

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: prompt, timestamp: Date.now() };
    setCurrentThread([userMsg]);
    setPrompt('');
    setIsLoading(true);
    setStreamingContent('');
    setToolStatus(null);
    setPendingConfirmation(null);
    setError('');

    const requestId = ++requestCounterRef.current;
    const abortController = isTauriRuntime ? undefined : new AbortController();
    activeRequestRef.current = { requestId, abortController };

    try {
      // Tool-capable models search the knowledge base on demand instead of
      // always paying for a pre-fetch that may not even be relevant.
      const toolCapable = modelSupportsTools(selectedModel);
      const knowledgeContext = toolCapable ? '' : await getKnowledgeContext(userMsg.content, knowledgePaths);
      const aiContent = await callLocalAI(
        [{ role: 'user', content: userMsg.content }],
        knowledgeContext,
        abortController?.signal,
        requestId,
        (delta) => {
          if (activeRequestRef.current?.requestId === requestId) {
            setStreamingContent((previous) => previous + delta);
          }
        },
        (tool, status) => {
          if (activeRequestRef.current?.requestId === requestId) {
            setToolStatus(status === 'done' ? null : { tool, status });
          }
        },
        knowledgePaths,
      );
      if (activeRequestRef.current?.requestId !== requestId) return;
      const aiMsg: Message = { id: (Date.now() + 1).toString(), role: 'assistant', content: aiContent, timestamp: Date.now() };
      setCurrentThread([userMsg, aiMsg]);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error(err);
      setError(err instanceof Error ? err.message : 'An error occurred. Please try again.');
      setCurrentThread([]);
    } finally {
      if (activeRequestRef.current?.requestId === requestId) {
        activeRequestRef.current = null;
        setIsLoading(false);
        setStreamingContent('');
        setToolStatus(null);
        setPendingConfirmation(null);
      }
    }
  };

  // Continue the conversation from the right-side input
  const handleThreadSubmit = async () => {
    if (!threadInput.trim() || isLoading) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: threadInput, timestamp: Date.now() };
    const updatedThread = [...currentThread, userMsg];
    setCurrentThread(updatedThread);
    setThreadInput('');
    setIsLoading(true);
    setStreamingContent('');
    setToolStatus(null);
    setPendingConfirmation(null);
    setError('');

    const requestId = ++requestCounterRef.current;
    const abortController = isTauriRuntime ? undefined : new AbortController();
    activeRequestRef.current = { requestId, abortController };

    try {
      const toolCapable = modelSupportsTools(selectedModel);
      const knowledgeContext = toolCapable ? '' : await getKnowledgeContext(threadInput, knowledgePaths);
      const aiContent = await callLocalAI(
        updatedThread.map(m => ({ role: m.role, content: m.content })),
        knowledgeContext,
        abortController?.signal,
        requestId,
        (delta) => {
          if (activeRequestRef.current?.requestId === requestId) {
            setStreamingContent((previous) => previous + delta);
          }
        },
        (tool, status) => {
          if (activeRequestRef.current?.requestId === requestId) {
            setToolStatus(status === 'done' ? null : { tool, status });
          }
        },
        knowledgePaths,
      );
      if (activeRequestRef.current?.requestId !== requestId) return;
      const aiMsg: Message = { id: (Date.now() + 1).toString(), role: 'assistant', content: aiContent, timestamp: Date.now() };
      setCurrentThread([...updatedThread, aiMsg]);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error(err);
      setError(err instanceof Error ? err.message : 'An error occurred. Please try again.');
    } finally {
      if (activeRequestRef.current?.requestId === requestId) {
        activeRequestRef.current = null;
        setIsLoading(false);
        setStreamingContent('');
        setToolStatus(null);
        setPendingConfirmation(null);
      }
    }
  };

  const handleCancelThinking = () => {
    if (!isLoading) return;

    activeRequestRef.current?.abortController?.abort();
    activeRequestRef.current = null;
    setIsLoading(false);
    setStreamingContent('');
    setToolStatus(null);
    setPendingConfirmation(null);
    setError('Request cancelled.');
  };

  const handleClear = () => { setPrompt(''); setError(''); };

  const handleClearHistory = () => {
    setPastThreads([]);
    setCurrentThread([]);
    localStorage.removeItem('artemis-past-threads');
    localStorage.removeItem('artemis-current-thread');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleThreadKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleThreadSubmit(); }
  };

  const addKnowledgePath = () => {
    const trimmed = newPathInput.trim();
    if (!trimmed) return;

    setKnowledgePaths((previous) => normalizeKnowledgePaths([...previous, trimmed]));
    setNewPathInput('');
  };

  const updateKnowledgePath = (index: number, value: string) => {
    setKnowledgePaths((previous) => previous.map((path, currentIndex) => (currentIndex === index ? value : path)));
  };

  const removeKnowledgePath = (index: number) => {
    setKnowledgePaths((previous) => {
      if (previous.length <= 1) return previous;
      return previous.filter((_, currentIndex) => currentIndex !== index);
    });
  };

  const handleNewPathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addKnowledgePath();
    }
  };

  const selectedModelProfile = getModelProfile(selectedModel);

  return (
    <div className={`app-container ${privacyMode ? 'privacy-active' : ''}`}>
      {pendingConfirmation && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 className="modal-title">
              {pendingConfirmation.action === 'delete_note' ? 'Confirm deletion' : 'Confirm change'}
            </h3>
            <p className="modal-description">{pendingConfirmation.details}</p>
            <div className="modal-buttons">
              <button type="button" className="modal-button modal-button-cancel" onClick={() => respondToConfirmation(false)}>
                Deny
              </button>
              <button type="button" className="modal-button modal-button-save" onClick={() => respondToConfirmation(true)}>
                Approve
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="tab-bar" role="tablist" aria-label="Artemis views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'chat'}
          className={`tab-bar-button ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'daily'}
          className={`tab-bar-button ${activeTab === 'daily' ? 'active' : ''}`}
          onClick={() => setActiveTab('daily')}
        >
          Daily
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'goals'}
          className={`tab-bar-button ${activeTab === 'goals' ? 'active' : ''}`}
          onClick={() => setActiveTab('goals')}
        >
          Goals
        </button>
      </div>

      {activeTab === 'goals' && (
        <div className="daily-dashboard goals-dashboard">
          <div className="daily-header">
            <h1 className="daily-title">Goals</h1>
            <p className="daily-date">
              {goalSections.length > 0
                ? `${goalSections.reduce((sum, section) => sum + section.items.filter((item) => item.done).length, 0)} / ${goalSections.reduce((sum, section) => sum + section.items.length, 0)} complete`
                : 'Master plan'}
            </p>
          </div>

          {!isTauriRuntime && <p className="settings-help">Goals are available in the desktop app.</p>}
          {isTauriRuntime && goalsError && <p className="daily-error">{goalsError}</p>}
          {isTauriRuntime && !goalsError && goalSections.length === 0 && <p className="settings-help">Loading goals…</p>}

          <div className="goals-sections">
            {goalSections.map((section, sectionIndex) => {
              const isExpanded = expandedGoalSections.has(sectionIndex);
              const sectionDone = section.items.filter((item) => item.done).length;
              return (
                <div className="goals-section" key={sectionIndex}>
                  <button
                    type="button"
                    className="goals-section-header"
                    onClick={() => toggleGoalSectionExpanded(sectionIndex)}
                    aria-expanded={isExpanded}
                  >
                    <ChevronDown size={16} className={`model-chevron ${isExpanded ? 'open' : ''}`} />
                    <span className="goals-section-title">{section.title}</span>
                    <span className="goals-section-count">{sectionDone}/{section.items.length}</span>
                  </button>
                  {isExpanded && (
                    <ul className="goals-item-list">
                      {section.items.map((item) => {
                        const isBreakingDown = breakingDownGoals.has(item.id);
                        return (
                          <li key={item.id} className={`goals-item ${item.done ? 'done' : ''}`}>
                            <div className="goals-item-row">
                              <label>
                                <input
                                  type="checkbox"
                                  checked={item.done}
                                  onChange={() => toggleGoalItem(sectionIndex, item.id, item.done)}
                                />
                                <span>{item.text}</span>
                              </label>
                              {item.sub_steps.length === 0 && (
                                <button
                                  type="button"
                                  className="goals-breakdown-button"
                                  onClick={() => breakDownGoal(sectionIndex, section.title, item.id, item.text)}
                                  disabled={isBreakingDown}
                                  title="Break this down into concrete steps"
                                >
                                  {isBreakingDown ? 'Breaking down… (~1-2 min)' : 'Break down'}
                                </button>
                              )}
                            </div>
                            {item.sub_steps.length > 0 && (
                              <ul className="goals-substep-list">
                                {item.sub_steps.map((step) => (
                                  <li key={step.id} className={`goals-substep ${step.done ? 'done' : ''}`}>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={step.done}
                                        onChange={() => toggleGoalSubstep(sectionIndex, item.id, step.id, step.done)}
                                      />
                                      <span>{step.text}</span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'daily' && (
        <div className="daily-dashboard">
          <div className="daily-header">
            <h1 className="daily-title">Daily</h1>
            <p className="daily-date">
              {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>

          {isTauriRuntime && irisFeedError && <p className="daily-error">{irisFeedError}</p>}
          {isTauriRuntime && irisFeed?.spark_text && <p className="brief-spark">"{irisFeed.spark_text}"</p>}

          {isTauriRuntime && irisFeed?.suggestion_text && (
            <div className="daily-card brief-suggestion-card">
              <h2 className="daily-card-title">Today's Suggestion (from Iris)</h2>
              <p className="brief-suggestion-text">{irisFeed.suggestion_text}</p>
              {irisFeed.suggestion_needs_answer && !suggestionAnswered ? (
                <div className="brief-suggestion-actions">
                  <button
                    type="button"
                    className="modal-button modal-button-cancel"
                    onClick={() => respondToIrisSuggestion('no')}
                    disabled={suggestionResponding}
                  >
                    No
                  </button>
                  <button
                    type="button"
                    className="modal-button modal-button-save"
                    onClick={() => respondToIrisSuggestion('yes')}
                    disabled={suggestionResponding}
                  >
                    Yes
                  </button>
                </div>
              ) : suggestionAnswered ? (
                <p className="settings-help">Sent to Iris.</p>
              ) : null}
            </div>
          )}

          <div className="daily-grid">
            <div className="daily-card">
              <h2 className="daily-card-title">Tasks</h2>
              <ul className="daily-task-list">
                {dailyTasks.length === 0 && <p className="settings-help">Nothing on your list — add one below, or just ask.</p>}
                {dailyTasks.map((task) => (
                  <li key={task.id} className={`daily-task ${task.done ? 'done' : ''}`}>
                    <label>
                      <input type="checkbox" checked={task.done} onChange={() => toggleDailyTask(task.id, task.done)} />
                      <span>{task.label}</span>
                    </label>
                    <button
                      type="button"
                      className="daily-task-remove"
                      onClick={() => removeDailyTask(task.id)}
                      aria-label="Remove task"
                      title="Remove task"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="settings-add-row daily-task-add-row">
                <input
                  value={newTaskInput}
                  onChange={(e) => setNewTaskInput(e.target.value)}
                  onKeyDown={handleNewTaskKeyDown}
                  className="settings-path-input"
                  placeholder="Add a task"
                />
                <button className="settings-add" onClick={addDailyTask} aria-label="Add task" title="Add task">
                  <Plus size={15} />
                </button>
              </div>
            </div>

            <div className="daily-card">
              <h2 className="daily-card-title">Scheduled</h2>
              {scheduledTasks.length === 0 && (
                <p className="settings-help">Nothing automated yet — ask Artemis to schedule something daily.</p>
              )}
              <ul className="daily-task-list">
                {scheduledTasks.map((task) => (
                  <li key={task.id} className="daily-task">
                    <div className="daily-scheduled-info">
                      <span className="daily-scheduled-title">{task.title}</span>
                      <span className="daily-scheduled-time">
                        Daily at {String(task.hour).padStart(2, '0')}:{String(task.minute).padStart(2, '0')}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="daily-task-remove"
                      onClick={() => cancelScheduledTask(task.id)}
                      aria-label="Cancel scheduled task"
                      title="Cancel scheduled task"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="daily-card">
              <h2 className="daily-card-title">Weather</h2>
              {!isTauriRuntime && <p className="settings-help">Weather is available in the desktop app.</p>}
              {isTauriRuntime && dailyWeatherError && <p className="daily-error">{dailyWeatherError}</p>}
              {isTauriRuntime && !dailyWeatherError && !dailyWeather && <p className="settings-help">Loading weather…</p>}
              {dailyWeather && (
                <div className="daily-weather-body">
                  <p className="daily-weather-temp">{Math.round(dailyWeather.temperature_f)}°F</p>
                  <p className="daily-weather-condition">{dailyWeather.condition}</p>
                  <p className="daily-weather-meta">{dailyWeather.location}</p>
                  <p className="daily-weather-meta">Wind {Math.round(dailyWeather.wind_mph)} mph</p>
                  <p className="daily-weather-change-hint">Change location in Settings</p>
                </div>
              )}
            </div>

            {DAILY_NEWS_CATEGORIES.map((category) => (
              <div className="daily-card" key={category}>
                <h2 className="daily-card-title">{category === 'Politics' ? 'Politics — NPR' : category}</h2>
                {!isTauriRuntime && <p className="settings-help">News is available in the desktop app.</p>}
                {isTauriRuntime && dailyNewsError && <p className="daily-error">{dailyNewsError}</p>}
                {isTauriRuntime && !dailyNewsError && dailyNews.length === 0 && (
                  <p className="settings-help">Loading headlines…</p>
                )}
                <ul className="daily-news-list">
                  {dailyNews
                    .filter((item) => item.category === category)
                    .map((item, index) => (
                      <li key={index} className="daily-news-item">
                        <a href={item.link} target="_blank" rel="noreferrer">{item.title}</a>
                        <span className="daily-news-source">{item.source}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}

            {isTauriRuntime && irisFeed?.brief_sections
              .filter((section) => !section.heading.toLowerCase().includes('weather'))
              .map((section, index) => (
                <div className="daily-card" key={`iris-brief-${index}`}>
                  <h2 className="daily-card-title">{section.heading} (Iris)</h2>
                  <p className="brief-section-content">{section.content}</p>
                </div>
              ))}
          </div>

          {isTauriRuntime && irisFeed && irisFeed.events_sections.length > 0 && (
            <>
              <h2 className="daily-card-title brief-subheading">This Week's Events (Iris)</h2>
              <div className="daily-grid">
                {irisFeed.events_sections.map((section, index) => (
                  <div className="daily-card" key={`events-${index}`}>
                    <h2 className="daily-card-title">{section.heading}</h2>
                    <p className="brief-section-content">{section.content}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          {isTauriRuntime && irisFeed && irisFeed.review_sections.length > 0 && (
            <>
              <h2 className="daily-card-title brief-subheading">Weekly Review (Iris)</h2>
              <div className="daily-grid">
                {irisFeed.review_sections.map((section, index) => (
                  <div className="daily-card" key={`review-${index}`}>
                    <h2 className="daily-card-title">{section.heading}</h2>
                    <p className="brief-section-content">{section.content}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'chat' && (
      <div className="main-content">

        {/* Left Section */}
        <div className="left-section">
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.1, ease: 'easeOut' }}
            className="brand-header"
          >
            <BrandMark className="brand-mark" size={108} />
            <div className="brand-wordmark">
              <h1 className="app-title">ARTEMIS</h1>
              <p className="brand-tagline">Lunar intelligence with a sharper edge.</p>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' }}
            className="app-subtitle"
          >
            <p>How may I serve you, Master?</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.45, ease: 'easeOut' }}
            className="model-selector"
            ref={modelMenuRef}
          >
            <span>Model</span>
            <button
              type="button"
              onClick={() => setIsModelMenuOpen((open) => !open)}
              disabled={isLoading}
              className="model-select-button"
              aria-haspopup="listbox"
              aria-expanded={isModelMenuOpen}
              title={selectedModelProfile.tag}
            >
              <span className="model-selected-nickname">{selectedModelProfile.nickname}</span>
              <ChevronDown size={16} className={`model-chevron ${isModelMenuOpen ? 'open' : ''}`} />
            </button>

            {isModelMenuOpen && (
              <div className="model-options-menu" role="listbox" aria-label="Model options">
                {modelOptions.map((model) => {
                  const profile = getModelProfile(model);
                  const isSelected = model === selectedModel;

                  return (
                    <button
                      key={model}
                      type="button"
                      className={`model-option-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedModel(model);
                        setIsModelMenuOpen(false);
                      }}
                      role="option"
                      aria-selected={isSelected}
                      title={profile.tag}
                    >
                      <span className="model-option-nickname">{profile.nickname}</span>
                      <span className="model-option-detail">{profile.detail}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>

          <motion.textarea
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5, ease: 'easeOut' }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What do you need from Artemis?"
            className="prompt-input"
          />

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="error-message"
            >
              <p>{error}</p>
            </motion.div>
          )}

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.7, ease: 'easeOut' }}
            className="button-group"
          >
            <button onClick={handleClear} disabled={isLoading || !prompt.trim()} className="button button-clear">
              Clear
            </button>
            <button onClick={handleSubmit} disabled={isLoading || !prompt.trim()} className="button button-submit">
              {isLoading && currentThread.length === 0 ? (
                <><Loader2 className="spinner" /><span>Loading...</span></>
              ) : 'Submit'}
            </button>
          </motion.div>

          {/* Past threads */}
          {pastThreads.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="left-history">
              <div className="left-history-header">
                <span className="left-history-title">Past</span>
                <button className="left-history-clear" onClick={handleClearHistory}>Clear</button>
              </div>
              {pastThreads.map((thread) => (
                <div key={thread.id} className="left-history-item">
                  <p className="left-history-prompt">{thread.firstMessage}</p>
                  <p className="left-history-time">
                    {new Date(thread.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              ))}
            </motion.div>
          )}

        </div>

        {/* Divider */}
        <div className="divider" />

        {/* Right Section — conversation thread */}
        <div className="right-section">
          <div className="header-actions">
            {indexProgress && (
              <div className="index-progress" title="Indexing your library in the background — search results improve as this completes">
                Indexing library… {indexProgress.done}/{indexProgress.total}
              </div>
            )}

            <button
              className={`privacy-toggle ${privacyMode ? 'active' : ''}`}
              onClick={() => setPrivacyMode((previous) => !previous)}
              aria-label="Toggle Privacy Mode"
              aria-pressed={privacyMode}
              title={privacyMode ? 'Privacy Mode is on — cloud models are hidden and unreachable' : 'Privacy Mode is off — cloud models are available'}
            >
              <Shield size={18} />
              <span>Privacy Mode</span>
            </button>

            <button
              className="settings-toggle"
              onClick={openActivity}
              aria-label="Open activity log"
              title="Activity log — every tool call, confirmation, and cloud request"
            >
              <ScrollText size={18} />
            </button>

            <button
              className="settings-toggle"
              onClick={openSettings}
              aria-label="Open knowledge settings"
              title="Knowledge settings"
            >
              <Settings size={20} />
            </button>
          </div>

          {isSettingsOpen && (
            <div className="settings-panel" role="dialog" aria-label="Knowledge paths settings">
              <div className="settings-header">
                <h3>Knowledge Paths</h3>
                <button
                  className="settings-close"
                  onClick={() => setIsSettingsOpen(false)}
                  aria-label="Close settings"
                >
                  <X size={18} />
                </button>
              </div>

              <p className="settings-help">Artemis scans these folders for context before responding.</p>

              <div className="settings-paths">
                {knowledgePaths.map((path, index) => {
                  const isSecret = secretPaths.includes(path.trim());
                  return (
                    <div className="settings-path-row" key={`${index}-${path}`}>
                      <input
                        value={path}
                        onChange={(e) => updateKnowledgePath(index, e.target.value)}
                        className="settings-path-input"
                        placeholder="C:\\folder\\with\\docs"
                      />
                      <button
                        type="button"
                        className={`settings-secret-toggle ${isSecret ? 'active' : ''}`}
                        onClick={() => toggleSecretPath(path.trim())}
                        aria-pressed={isSecret}
                        title={isSecret ? 'Secret — cloud models can never see this folder, regardless of Privacy Mode' : 'Mark this folder as Secret (cloud-inaccessible)'}
                      >
                        <Shield size={13} />
                      </button>
                      <button
                        className="settings-remove"
                        onClick={() => removeKnowledgePath(index)}
                        disabled={knowledgePaths.length <= 1}
                        aria-label="Remove path"
                        title="Remove path"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="settings-add-row">
                <input
                  value={newPathInput}
                  onChange={(e) => setNewPathInput(e.target.value)}
                  onKeyDown={handleNewPathKeyDown}
                  className="settings-path-input"
                  placeholder="Add another folder path"
                />
                <button className="settings-add" onClick={addKnowledgePath} aria-label="Add path" title="Add path">
                  <Plus size={15} />
                </button>
              </div>

              <div className="settings-section-divider" />

              <h3>Ollama Cloud</h3>
              <p className="settings-help">
                {hasCloudKey
                  ? 'A cloud API key is saved. Turn off Privacy Mode to see and use cloud models.'
                  : 'Add an API key from ollama.com to enable cloud models. It stays on this machine and is never shown again once saved.'}
              </p>

              {hasCloudKey ? (
                <button className="settings-remove-key" onClick={clearCloudKey}>
                  Remove saved key
                </button>
              ) : (
                <div className="settings-add-row">
                  <input
                    type="password"
                    value={cloudKeyInput}
                    onChange={(e) => setCloudKeyInput(e.target.value)}
                    className="settings-path-input"
                    placeholder="Paste your Ollama Cloud API key"
                  />
                  <button className="settings-add" onClick={saveCloudKey} aria-label="Save key" title="Save key">
                    <Plus size={15} />
                  </button>
                </div>
              )}

              <div className="settings-section-divider" />

              <h3>Remote Ollama</h3>
              <p className="settings-help">
                {remoteOllamaConfig
                  ? `Connected to "${remoteOllamaConfig.label}" (${remoteOllamaConfig.base_url}). Its models appear in the picker, always available regardless of Privacy Mode — it's your own hardware, not a third party.`
                  : "Point Artemis at a second Ollama instance you own — a home server on your own Tailscale network, for example. Needs that machine's Tailscale IP and Ollama already running there."}
              </p>
              {remoteOllamaConfig ? (
                <button className="settings-remove-key" onClick={clearRemoteOllamaConfig}>
                  Remove saved connection
                </button>
              ) : (
                <>
                  <div className="settings-add-row">
                    <input
                      value={remoteOllamaLabelInput}
                      onChange={(e) => setRemoteOllamaLabelInput(e.target.value)}
                      className="settings-path-input"
                      placeholder="Label, e.g. Horus"
                    />
                  </div>
                  <div className="settings-add-row">
                    <input
                      value={remoteOllamaUrlInput}
                      onChange={(e) => setRemoteOllamaUrlInput(e.target.value)}
                      className="settings-path-input"
                      placeholder="http://100.x.x.x:11434"
                    />
                    <button className="settings-add" onClick={saveRemoteOllamaConfig} aria-label="Save remote Ollama connection" title="Save">
                      <Plus size={15} />
                    </button>
                  </div>
                </>
              )}

              <div className="settings-section-divider" />

              <h3>Home Assistant</h3>
              <p className="settings-help">
                {hasHomeAssistant
                  ? 'Connected. Ask Artemis to control devices or list entities.'
                  : 'Add your Home Assistant URL and a long-lived access token to let Artemis control devices. Device actions always ask for approval first.'}
              </p>
              {hasHomeAssistant ? (
                <button className="settings-remove-key" onClick={clearHomeAssistantConfig}>
                  Remove saved connection
                </button>
              ) : (
                <>
                  <div className="settings-add-row">
                    <input
                      value={homeAssistantUrlInput}
                      onChange={(e) => setHomeAssistantUrlInput(e.target.value)}
                      className="settings-path-input"
                      placeholder="http://homeassistant.local:8123"
                    />
                  </div>
                  <div className="settings-add-row">
                    <input
                      type="password"
                      value={homeAssistantTokenInput}
                      onChange={(e) => setHomeAssistantTokenInput(e.target.value)}
                      className="settings-path-input"
                      placeholder="Long-lived access token"
                    />
                    <button className="settings-add" onClick={saveHomeAssistantConfig} aria-label="Save Home Assistant connection" title="Save">
                      <Plus size={15} />
                    </button>
                  </div>
                </>
              )}

              <div className="settings-section-divider" />

              <h3>GitHub</h3>
              <p className="settings-help">
                {hasGithubToken
                  ? 'Connected. Ask Artemis to check issues, PR status, or post updates.'
                  : 'Add a personal access token to let Artemis read issues/PRs and post comments. Posting or creating issues always asks for approval first.'}
              </p>
              {hasGithubToken ? (
                <button className="settings-remove-key" onClick={clearGithubToken}>
                  Remove saved token
                </button>
              ) : (
                <div className="settings-add-row">
                  <input
                    type="password"
                    value={githubTokenInput}
                    onChange={(e) => setGithubTokenInput(e.target.value)}
                    className="settings-path-input"
                    placeholder="Paste your GitHub personal access token"
                  />
                  <button className="settings-add" onClick={saveGithubToken} aria-label="Save GitHub token" title="Save token">
                    <Plus size={15} />
                  </button>
                </div>
              )}

              <div className="settings-section-divider" />

              <h3>Hermes Gateway</h3>
              <p className="settings-help">
                {hasHermesGateway
                  ? 'Connected. Artemis can start durable, steerable Hermes runs.'
                  : "For durable/background Hermes runs (vs. a one-shot call). Enable gateway.api_server in Hermes's own config and run `hermes gateway`, then paste its URL and key here."}
              </p>
              {hasHermesGateway ? (
                <button className="settings-remove-key" onClick={clearHermesGatewayConfig}>
                  Remove saved connection
                </button>
              ) : (
                <>
                  <div className="settings-add-row">
                    <input
                      value={hermesGatewayUrlInput}
                      onChange={(e) => setHermesGatewayUrlInput(e.target.value)}
                      className="settings-path-input"
                      placeholder="http://127.0.0.1:8642"
                    />
                  </div>
                  <div className="settings-add-row">
                    <input
                      type="password"
                      value={hermesGatewayKeyInput}
                      onChange={(e) => setHermesGatewayKeyInput(e.target.value)}
                      className="settings-path-input"
                      placeholder="Gateway API key"
                    />
                    <button className="settings-add" onClick={saveHermesGatewayConfig} aria-label="Save Hermes gateway connection" title="Save">
                      <Plus size={15} />
                    </button>
                  </div>
                </>
              )}

              <div className="settings-section-divider" />

              <h3>Location</h3>
              <p className="settings-help">
                Used for the Daily tab's weather. Currently: {location ? location.label : 'Tucker, GA (default)'}
              </p>
              <div className="settings-add-row">
                <input
                  value={locationQuery}
                  onChange={(e) => setLocationQuery(e.target.value)}
                  onKeyDown={handleLocationKeyDown}
                  className="settings-path-input"
                  placeholder="Search for a city"
                />
                <button className="settings-add" onClick={searchLocation} disabled={isLocationSearching} aria-label="Search location" title="Search location">
                  {isLocationSearching ? <Loader2 className="spinner" size={15} /> : <Plus size={15} />}
                </button>
              </div>
              {locationResults.length > 0 && (
                <div className="location-results">
                  {locationResults.map((result, index) => (
                    <button
                      type="button"
                      key={index}
                      className="location-result-item"
                      onClick={() => selectLocation(result)}
                    >
                      {formatGeocodeResult(result)}
                    </button>
                  ))}
                </div>
              )}

              <div className="settings-section-divider" />

              <h3>Documents</h3>
              <p className="settings-help">Upload a file for Artemis to ingest into your knowledge base.</p>
              <button className="settings-action-button" onClick={uploadDocument} disabled={isUploading}>
                {isUploading ? 'Uploading…' : 'Choose a document…'}
              </button>
              {uploadStatus && <p className="settings-help">{uploadStatus}</p>}

              <div className="settings-section-divider" />

              <h3>Memory</h3>
              <p className="settings-help">
                {userMemory
                  ? "What Artemis has learned about you so far — say \"remember that...\" to add more."
                  : 'Nothing learned yet — say "remember that..." in chat to teach Artemis something durable.'}
              </p>
              {userMemory && <pre className="memory-content">{userMemory}</pre>}
            </div>
          )}

          {isActivityOpen && (
            <div className="settings-panel" role="dialog" aria-label="Activity log">
              <div className="settings-header">
                <h3>Activity</h3>
                <button className="settings-close" onClick={() => setIsActivityOpen(false)} aria-label="Close activity log">
                  <X size={18} />
                </button>
              </div>

              <p className="settings-help">Every tool call, confirmation, and cloud request, most recent first.</p>

              <div className="activity-list">
                {activityEntries.length === 0 && <p className="settings-help">Nothing logged yet.</p>}
                {activityEntries.map((entry, index) => (
                  <div className="activity-entry" key={index}>
                    <div className="activity-entry-header">
                      <span className="activity-entry-event">{formatActivityEvent(entry.event)}</span>
                      <span className="activity-entry-time">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    </div>
                    <p className="activity-entry-detail">{entry.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="thread-messages">
            {currentThread.length === 0 && !isLoading ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 1, delay: 1 }}
                className="empty-state"
              >
                <p>Your conversation will appear here</p>
              </motion.div>
            ) : (
              <>
                {currentThread.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35 }}
                    className={`thread-message thread-message-${msg.role}`}
                  >
                    <p className="thread-role">{msg.role === 'user' ? 'You' : 'Artemis'}</p>
                    <p className="thread-content">{msg.content}</p>
                    <p className="thread-timestamp">
                      {new Date(msg.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      {' · '}
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </motion.div>
                ))}

                {isLoading && (
                  <div className="thread-message thread-message-assistant">
                    <p className="thread-role">Artemis</p>
                    {streamingContent && (
                      <p className="thread-content">{streamingContent}</p>
                    )}
                    <div className="loading-state">
                      {!streamingContent && !toolStatus && (
                        <>
                          <Loader2 className="spinner-large" />
                          <p>Thinking...</p>
                        </>
                      )}
                      {toolStatus && (
                        <>
                          <Loader2 className="spinner-large" />
                          <p>{getToolStatusLabel(toolStatus.tool, toolStatus.status)}</p>
                        </>
                      )}
                      <button
                        type="button"
                        className="loading-cancel"
                        onClick={handleCancelThinking}
                        aria-label="Cancel response"
                        title="Cancel response"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div ref={threadEndRef} />
              </>
            )}
          </div>

          {/* Reply input — only shown when a thread is active */}
          {(currentThread.length > 0 || isLoading) && (
            <div className="thread-input-area">
              <textarea
                value={threadInput}
                onChange={(e) => setThreadInput(e.target.value)}
                onKeyDown={handleThreadKeyDown}
                placeholder="Continue the conversation..."
                className="thread-input"
                disabled={isLoading}
              />
              <button
                onClick={handleThreadSubmit}
                disabled={isLoading || !threadInput.trim()}
                className="thread-send"
              >
                <Send size={18} />
              </button>
            </div>
          )}
        </div>

      </div>
      )}
    </div>
  );
}
