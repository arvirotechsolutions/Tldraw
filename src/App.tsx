import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Database,
  Edit3,
  FileText,
  Folder,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutGrid,
  Link,
  LoaderCircle,
  Minus,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Wand2,
  Zap,
  X,
} from 'lucide-react';
import {
  Tldraw,
  getSnapshot,
  loadSnapshot,
  toRichText,
  type Editor,
  type TLEditorSnapshot,
  type TLStoreSnapshot,
} from 'tldraw';
import 'tldraw/tldraw.css';
import './App.css';

type AppView = 'shell' | 'editor';
type AppTab = 'home' | 'settings' | 'updates' | 'llm';
type BoardSnapshot = TLEditorSnapshot | TLStoreSnapshot;

type BoardRecord = {
  id: string;
  name: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
};

type BoardFile = {
  version: 1;
  board: BoardRecord;
  snapshot: BoardSnapshot | null;
};

type AppSettings = {
  theme: 'light' | 'dark';
  defaultBoardFolder: string;
  autosave: boolean;
  confirmOverwrite: boolean;
  openLastBoard: boolean;
};

type LLMConfig = {
  enabled: boolean;
  provider: string;
  modelName: string;
  endpoint: string;
  apiKey: string;
  temperature: number;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type DiagramNode = {
  id: string;
  label: string;
  detail?: string;
  type?: 'process' | 'database' | 'external' | 'decision' | 'note' | 'security' | 'rate-limit' | 'traffic';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string;
};

type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  priority?: 'security' | 'traffic' | 'rate-limit' | 'data' | 'control';
};

type DiagramSpec = {
  title?: string;
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
};

type StoredAppState = {
  boards: BoardRecord[];
  settings: AppSettings;
  llm: LLMConfig;
};

type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseName: string;
  publishedAt: string;
};

const STORAGE_KEY = 'tldraw-local-app-state';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  defaultBoardFolder: '',
  autosave: true,
  confirmOverwrite: true,
  openLastBoard: false,
};

const DEFAULT_LLM_CONFIG: LLMConfig = {
  enabled: false,
  provider: 'OpenAI compatible',
  modelName: 'gpt-4.1-mini',
  endpoint: 'https://api.example.com/v1',
  apiKey: '',
  temperature: 0.3,
};

const APP_BUTTON_CLASS =
  'bg-white text-black px-5 py-2.5 rounded-xl font-bold text-[14px] shadow-sm transition-all duration-300 hover:bg-gray-100 active:scale-95 border border-gray-200/60 cursor-pointer flex items-center gap-2';
const APP_BUTTON_DISABLED_CLASS = 'disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100';

const PROVIDER_PRESETS: Record<string, Pick<LLMConfig, 'endpoint' | 'modelName'>> = {
  OpenAI: { endpoint: 'https://api.openai.com/v1', modelName: 'gpt-4.1-mini' },
  Gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-1.5-pro' },
  Claude: { endpoint: 'https://api.anthropic.com/v1', modelName: 'claude-3-5-sonnet-latest' },
  'OpenAI compatible': { endpoint: 'https://api.example.com/v1', modelName: 'gpt-4.1-mini' },
  Ollama: { endpoint: 'http://localhost:11434/v1', modelName: 'llama3.1' },
  'Local server': { endpoint: 'http://localhost:8000/v1', modelName: 'local-model' },
};

const AGENT_WORK_STEPS = [
  'Reading request',
  'Planning components',
  'Mapping boundaries',
  'Routing connections',
  'Drawing diagram',
];

function readStoredAppState(): StoredAppState {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) {
      return { boards: [], settings: DEFAULT_SETTINGS, llm: DEFAULT_LLM_CONFIG };
    }

    const parsed = JSON.parse(value) as Partial<StoredAppState>;
    return {
      boards: Array.isArray(parsed.boards) ? parsed.boards : [],
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      llm: { ...DEFAULT_LLM_CONFIG, ...parsed.llm },
    };
  } catch {
    return { boards: [], settings: DEFAULT_SETTINGS, llm: DEFAULT_LLM_CONFIG };
  }
}

function sanitizeFileName(value: string) {
  const safeName = value
    .replace(/[<>:"/\\|?*]+/g, '-')
    .trim()
    .replace(/\.+$/g, '');

  return safeName || 'Untitled Board';
}

function joinBoardPath(folder: string, name: string) {
  const separator = folder.includes('/') && !folder.includes('\\') ? '/' : '\\';
  return `${folder.replace(/[\\/]+$/g, '')}${separator}${sanitizeFileName(name)}.tldr.json`;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));

  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hours ago`;
  if (minutes < 2880) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function App() {
  const appWindow = getCurrentWindow();
  const storedStateRef = useRef(readStoredAppState());
  const autoOpenedLastBoardRef = useRef(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [view, setView] = useState<AppView>('shell');
  const [boards, setBoards] = useState<BoardRecord[]>(storedStateRef.current.boards);
  const [settings, setSettings] = useState<AppSettings>(storedStateRef.current.settings);
  const [llmConfig, setLlmConfig] = useState<LLMConfig>(storedStateRef.current.llm);
  const [activeBoard, setActiveBoard] = useState<BoardRecord | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<BoardSnapshot | null>(null);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ boards, settings, llm: llmConfig }));
  }, [boards, settings, llmConfig]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  const upsertBoard = useCallback((board: BoardRecord) => {
    setBoards((current) => {
      const existing = current.filter((item) => item.id !== board.id);
      return [board, ...existing].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    });
  }, []);

  const handleCreateBoard = async (name: string, filePath: string) => {
    if (settings.confirmOverwrite) {
      try {
        await invoke('read_board_file', { path: filePath.trim() });
        const shouldOverwrite = window.confirm('A board file already exists at this path. Replace it with a new empty board?');
        if (!shouldOverwrite) return;
      } catch {
        // Missing or unreadable files are safe to create over; write errors still surface below.
      }
    }

    const now = new Date().toISOString();
    const board: BoardRecord = {
      id: crypto.randomUUID(),
      name: name.trim(),
      filePath: filePath.trim(),
      createdAt: now,
      updatedAt: now,
    };

    const payload: BoardFile = {
      version: 1,
      board,
      snapshot: null,
    };

    await invoke('write_board_file', { path: board.filePath, payload });
    upsertBoard(board);
    setActiveBoard(board);
    setActiveSnapshot(null);
    setView('editor');
  };

  const handleOpenBoard = async (board: BoardRecord) => {
    try {
      const file = await invoke<BoardFile>('read_board_file', { path: board.filePath });
      const fileBoard = file.board ? { ...board, ...file.board } : board;
      upsertBoard(fileBoard);
      setActiveBoard(fileBoard);
      setActiveSnapshot(file.snapshot ?? null);
    } catch {
      setActiveBoard(board);
      setActiveSnapshot(null);
    }

    setView('editor');
  };

  const handleRenameBoard = async (board: BoardRecord, name: string, snapshot?: BoardSnapshot | null) => {
    const nextBoard = {
      ...board,
      name: name.trim(),
      updatedAt: new Date().toISOString(),
    };

    let nextSnapshot = snapshot;
    if (typeof nextSnapshot === 'undefined') {
      try {
        const file = await invoke<BoardFile>('read_board_file', { path: board.filePath });
        nextSnapshot = file.snapshot ?? null;
      } catch {
        nextSnapshot = null;
      }
    }

    await invoke('write_board_file', {
      path: board.filePath,
      payload: {
        version: 1,
        board: nextBoard,
        snapshot: nextSnapshot,
      },
    });

    upsertBoard(nextBoard);
    setActiveBoard((current) => (current?.id === board.id ? nextBoard : current));
  };

  const handleDeleteBoard = async (board: BoardRecord, deleteFile: boolean) => {
    if (deleteFile) {
      await invoke('delete_board_file', { path: board.filePath });
    }

    setBoards((current) => current.filter((item) => item.id !== board.id));

    if (activeBoard?.id === board.id) {
      setActiveBoard(null);
      setActiveSnapshot(null);
      setView('shell');
    }
  };

  useEffect(() => {
    if (autoOpenedLastBoardRef.current || !settings.openLastBoard || view !== 'shell' || boards.length === 0) {
      return;
    }

    autoOpenedLastBoardRef.current = true;
    void handleOpenBoard(boards[0]);
  }, [boards, settings.openLastBoard, view]);

  if (view === 'editor' && activeBoard) {
    return (
      <EditorView
        board={activeBoard}
        initialSnapshot={activeSnapshot}
        autosave={settings.autosave}
        llmConfig={llmConfig}
        onBack={() => setView('shell')}
        onBoardSaved={(board) => {
          setActiveBoard(board);
          upsertBoard(board);
        }}
        onRenameBoard={handleRenameBoard}
        onDeleteBoard={handleDeleteBoard}
      />
    );
  }

  return (
    <div className="flex h-screen w-full bg-[#f6f5f3] text-gray-900 overflow-hidden relative select-none">
      <div
        data-tauri-drag-region
        className="absolute top-0 left-0 right-0 h-12 flex items-center justify-between pointer-events-auto z-50"
      >
        <div className="flex items-center h-full pointer-events-auto ml-2">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="h-12 w-12 text-gray-500 hover:bg-gray-200/60 hover:text-black transition-all flex items-center justify-center cursor-pointer"
            title="Toggle sidebar"
          >
            {isSidebarOpen ? <PanelLeftClose size={22} strokeWidth={1.5} /> : <PanelLeft size={22} strokeWidth={1.5} />}
          </button>
        </div>

        <WindowControls appWindow={appWindow} />
      </div>

      <div className="flex w-full h-full pt-12 pb-4 pr-4">
        <motion.div
          animate={{ width: isSidebarOpen ? 260 : 64 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="shrink-0 h-full overflow-hidden mr-3"
        >
          <div className="w-[260px] flex flex-col h-full">
            <div>
              <div className="flex items-center mb-6 mt-1 px-[22px] h-8">
                <span className={`font-bold text-[22px] tracking-tight text-black whitespace-nowrap transition-opacity duration-200 ${isSidebarOpen ? 'opacity-100' : 'opacity-0'}`}>
                  Tldraw
                </span>
              </div>

              <div className="px-2 mt-2 space-y-1">
                <NavItem icon={<LayoutGrid size={18} strokeWidth={2} />} label="Home" active={activeTab === 'home'} onClick={() => setActiveTab('home')} isSidebarOpen={isSidebarOpen} />
                <NavItem icon={<Settings size={18} strokeWidth={2} />} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} isSidebarOpen={isSidebarOpen} />
                <NavItem icon={<RefreshCw size={18} strokeWidth={2} />} label="Check for updates" active={activeTab === 'updates'} onClick={() => setActiveTab('updates')} isSidebarOpen={isSidebarOpen} />
                <NavItem icon={<Sparkles size={18} strokeWidth={2} />} label="LLM" active={activeTab === 'llm'} onClick={() => setActiveTab('llm')} isSidebarOpen={isSidebarOpen} />
              </div>
            </div>
          </div>
        </motion.div>

        <div className="flex-1 bg-white rounded-[24px] shadow-[0_2px_15px_rgba(0,0,0,0.03)] border border-gray-100 flex overflow-hidden">
          <AnimatePresence mode="wait">
            {activeTab === 'home' && <HomeView key="home" boards={boards} settings={settings} onCreateBoard={handleCreateBoard} onOpenBoard={handleOpenBoard} onRenameBoard={handleRenameBoard} onDeleteBoard={handleDeleteBoard} />}
            {activeTab === 'settings' && <SettingsView key="settings" settings={settings} onSave={setSettings} />}
            {activeTab === 'updates' && <UpdatesView key="updates" />}
            {activeTab === 'llm' && <LLMView key="llm" config={llmConfig} onSave={setLlmConfig} />}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function WindowControls({ appWindow }: { appWindow: ReturnType<typeof getCurrentWindow> }) {
  const handleWindowAction = (action: () => Promise<void>) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    action().catch((error) => console.error('Window action failed', error));
  };

  return (
    <div className="flex items-center h-full pointer-events-auto">
      <button type="button" onClick={handleWindowAction(() => appWindow.minimize())} className="h-12 w-12 text-gray-600 hover:bg-gray-200/60 hover:text-black transition-all flex items-center justify-center cursor-pointer" title="Minimize">
        <Minus size={20} strokeWidth={1.5} />
      </button>
      <button type="button" onClick={handleWindowAction(() => appWindow.toggleMaximize())} className="h-12 w-12 text-gray-600 hover:bg-gray-200/60 hover:text-black transition-all flex items-center justify-center cursor-pointer" title="Maximize">
        <Square size={16} strokeWidth={2} />
      </button>
      <button type="button" onClick={handleWindowAction(() => appWindow.close())} className="h-12 w-[48px] text-gray-600 hover:bg-red-500 hover:text-white transition-all flex items-center justify-center cursor-pointer" title="Close">
        <X size={20} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function NavItem({ icon, label, active, onClick, isSidebarOpen }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void; isSidebarOpen?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`cursor-pointer flex items-center py-[10px] rounded-xl text-[14px] font-medium transition-all duration-300 group overflow-hidden ${
        isSidebarOpen ? 'w-full px-[22px]' : 'w-[44px] px-0 justify-center ml-[2px]'
      } ${active ? 'bg-[#e9e4df] text-black font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.02)]' : 'text-[#4b5563] hover:bg-[#e9e4df]/60 hover:text-black hover:scale-[0.98]'}`}
      title={!isSidebarOpen ? label : undefined}
    >
      <span className={`shrink-0 flex items-center justify-center transition-colors duration-200 ${active ? 'text-black' : 'text-[#6b7280] group-hover:text-black'}`}>
        {icon}
      </span>
      <span className={`tracking-tight whitespace-nowrap overflow-hidden transition-all duration-300 ${isSidebarOpen ? 'opacity-100 ml-4 w-auto' : 'opacity-0 ml-0 w-0'}`}>
        {label}
      </span>
    </button>
  );
}

function HomeView({
  boards,
  settings,
  onCreateBoard,
  onOpenBoard,
  onRenameBoard,
  onDeleteBoard,
}: {
  boards: BoardRecord[];
  settings: AppSettings;
  onCreateBoard: (name: string, filePath: string) => Promise<void>;
  onOpenBoard: (board: BoardRecord) => Promise<void>;
  onRenameBoard: (board: BoardRecord, name: string) => Promise<void>;
  onDeleteBoard: (board: BoardRecord, deleteFile: boolean) => Promise<void>;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingBoard, setEditingBoard] = useState<BoardRecord | null>(null);
  const [deletingBoard, setDeletingBoard] = useState<BoardRecord | null>(null);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex-1 flex flex-col p-12 pr-8 pb-0 min-w-0">
      <div className="mb-10 flex items-center justify-between">
        <div className="text-[18px] text-black font-medium tracking-tight">Drawing Boards</div>
        <button onClick={() => setIsDialogOpen(true)} className={APP_BUTTON_CLASS}>
          <Plus size={16} strokeWidth={2.5} />
          Create board
        </button>
      </div>

      <div className="flex-1 flex flex-col relative min-h-0">
        <div className="text-[#9ca3af] text-[12px] font-bold tracking-[0.1em] uppercase mb-4 px-2 shrink-0">Recent Boards</div>

        <div className="flex-1 overflow-y-auto hide-scrollbar border border-gray-100/80 rounded-2xl mb-12 shadow-[0_2px_10px_rgba(0,0,0,0.01)] relative">
          {boards.length === 0 ? (
            <div className="h-full min-h-[320px] flex flex-col items-center justify-center text-center px-8">
              <div className="h-12 w-12 rounded-2xl bg-[#f4f0ea] flex items-center justify-center text-black mb-5">
                <FileText size={22} strokeWidth={1.8} />
              </div>
              <div className="text-[16px] font-semibold text-black mb-1">No boards yet</div>
              <div className="text-[13.5px] text-[#8f969f] max-w-sm">Create a board, choose where its file should live, and the drawing will be saved there automatically.</div>
            </div>
          ) : (
            boards.map((board, index) => (
              <BoardRow key={board.id} board={board} isLast={index === boards.length - 1} onOpen={() => onOpenBoard(board)} onRename={() => setEditingBoard(board)} onDelete={() => setDeletingBoard(board)} />
            ))
          )}
        </div>
      </div>

      <CreateBoardDialog isOpen={isDialogOpen} settings={settings} onClose={() => setIsDialogOpen(false)} onCreate={onCreateBoard} />
      <RenameBoardDialog isOpen={Boolean(editingBoard)} board={editingBoard} onClose={() => setEditingBoard(null)} onRename={onRenameBoard} />
      <DeleteBoardDialog isOpen={Boolean(deletingBoard)} board={deletingBoard} onClose={() => setDeletingBoard(null)} onDelete={onDeleteBoard} />
    </motion.div>
  );
}

function BoardRow({ board, isLast, onOpen, onRename, onDelete }: { board: BoardRecord; isLast?: boolean; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
  return (
    <div className={`w-full flex items-center px-8 transition-colors duration-300 hover:bg-gray-50/70 group ${!isLast ? 'border-b border-gray-100' : ''}`}>
      <button onClick={onOpen} className="min-w-0 flex-1 flex items-center py-[18px] cursor-pointer text-left">
        <div className="w-[130px] shrink-0 text-[13.5px] text-[#9ca3af] font-medium">{formatUpdatedAt(board.updatedAt)}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] text-black font-medium truncate">{board.name}</div>
          <div className="text-[12.5px] text-[#9ca3af] font-medium truncate mt-1">{board.filePath}</div>
        </div>
        <ArrowRight size={16} className="ml-5 shrink-0 text-gray-300 transition-colors group-hover:text-black" />
      </button>
      <div className="ml-5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button type="button" onClick={onRename} className="h-9 w-9 rounded-xl text-gray-500 hover:bg-gray-100 hover:text-black flex items-center justify-center cursor-pointer" title="Rename board">
          <Edit3 size={15} />
        </button>
        <button type="button" onClick={onDelete} className="h-9 w-9 rounded-xl text-gray-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center cursor-pointer" title="Delete board">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

function RenameBoardDialog({ isOpen, board, onClose, onRename }: { isOpen: boolean; board: BoardRecord | null; onClose: () => void; onRename: (board: BoardRecord, name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!board) return;
    setName(board.name);
    setError('');
  }, [board]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!board) return;

    const nextName = name.trim();
    if (!nextName) {
      setError('Board name is required.');
      return;
    }

    setIsSaving(true);
    setError('');
    try {
      await onRename(board, nextName);
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && board && (
        <motion.div className="fixed inset-0 z-[80] bg-black/25 backdrop-blur-[2px] flex items-center justify-center px-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.form onSubmit={handleSubmit} className="w-full max-w-[460px] rounded-[22px] bg-white shadow-[0_28px_90px_rgba(15,18,25,0.22)] border border-white/80 overflow-hidden" initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }} transition={{ duration: 0.2 }}>
            <div className="px-8 pt-7 pb-5 border-b border-gray-100 flex items-start justify-between gap-5">
              <div>
                <div className="text-[20px] font-bold tracking-tight text-black">Rename board</div>
                <div className="text-[13.5px] text-[#8f969f] mt-1">Update the board name shown in the app.</div>
              </div>
              <button type="button" onClick={onClose} className="h-9 w-9 rounded-xl text-gray-500 hover:bg-gray-100 hover:text-black flex items-center justify-center cursor-pointer" title="Close">
                <X size={18} />
              </button>
            </div>

            <div className="px-8 py-6">
              <label className="block">
                <span className="text-[13px] font-bold text-black mb-2 block">Board name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} autoFocus className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium" />
              </label>
              {error && <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">{error}</div>}
            </div>

            <div className="px-8 py-5 bg-[#faf9f7] border-t border-gray-100 flex justify-end gap-3">
              <button type="button" onClick={onClose} className={APP_BUTTON_CLASS}>Cancel</button>
              <button type="submit" disabled={isSaving} className={`${APP_BUTTON_CLASS} ${APP_BUTTON_DISABLED_CLASS}`}>
                <Edit3 size={16} />
                {isSaving ? 'Saving...' : 'Rename'}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DeleteBoardDialog({ isOpen, board, onClose, onDelete }: { isOpen: boolean; board: BoardRecord | null; onClose: () => void; onDelete: (board: BoardRecord, deleteFile: boolean) => Promise<void> }) {
  const [deleteFile, setDeleteFile] = useState(true);
  const [error, setError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!board) return;
    setDeleteFile(true);
    setError('');
  }, [board]);

  const handleDelete = async () => {
    if (!board) return;

    setIsDeleting(true);
    setError('');
    try {
      await onDelete(board, deleteFile);
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && board && (
        <motion.div className="fixed inset-0 z-[80] bg-black/25 backdrop-blur-[2px] flex items-center justify-center px-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="w-full max-w-[500px] rounded-[22px] bg-white shadow-[0_28px_90px_rgba(15,18,25,0.22)] border border-white/80 overflow-hidden" initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }} transition={{ duration: 0.2 }}>
            <div className="px-8 pt-7 pb-5 border-b border-gray-100 flex items-start justify-between gap-5">
              <div>
                <div className="text-[20px] font-bold tracking-tight text-black">Delete board</div>
                <div className="text-[13.5px] text-[#8f969f] mt-1">Remove “{board.name}” from this workspace.</div>
              </div>
              <button type="button" onClick={onClose} className="h-9 w-9 rounded-xl text-gray-500 hover:bg-gray-100 hover:text-black flex items-center justify-center cursor-pointer" title="Close">
                <X size={18} />
              </button>
            </div>

            <div className="px-8 py-6 space-y-4">
              <label className="flex items-start gap-3 rounded-xl border border-red-100 bg-red-50 px-4 py-4 cursor-pointer">
                <input type="checkbox" checked={deleteFile} onChange={(event) => setDeleteFile(event.target.checked)} className="mt-1 accent-red-600" />
                <span>
                  <span className="block text-[13.5px] font-bold text-red-800">Delete the board file too</span>
                  <span className="mt-1 block text-[12.5px] font-medium text-red-800/75 break-all">{board.filePath}</span>
                </span>
              </label>
              {!deleteFile && <div className="rounded-xl border border-gray-100 bg-[#faf9f7] px-4 py-3 text-[12.5px] font-medium text-[#6b7280]">The board will disappear from the list, but the .tldr.json file will stay on disk.</div>}
              {error && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">{error}</div>}
            </div>

            <div className="px-8 py-5 bg-[#faf9f7] border-t border-gray-100 flex justify-end gap-3">
              <button type="button" onClick={onClose} className={APP_BUTTON_CLASS}>Cancel</button>
              <button type="button" onClick={handleDelete} disabled={isDeleting} className={`${APP_BUTTON_CLASS} ${APP_BUTTON_DISABLED_CLASS} hover:bg-red-50 hover:text-red-700`}>
                <Trash2 size={16} />
                {isDeleting ? 'Deleting...' : 'Delete board'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CreateBoardDialog({ isOpen, settings, onClose, onCreate }: { isOpen: boolean; settings: AppSettings; onClose: () => void; onCreate: (name: string, filePath: string) => Promise<void> }) {
  const [name, setName] = useState('Untitled Board');
  const [filePath, setFilePath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen || pathTouched) return;

    let cancelled = false;

    if (settings.defaultBoardFolder.trim()) {
      setFilePath(joinBoardPath(settings.defaultBoardFolder, name));
    } else {
      invoke<string>('default_board_path', { name })
        .then((path) => {
          if (!cancelled) setFilePath(path);
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, name, pathTouched, settings.defaultBoardFolder]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Board name is required.');
      return;
    }

    if (!filePath.trim()) {
      setError('Storage path is required.');
      return;
    }

    setIsSaving(true);
    try {
      await onCreate(name, filePath);
      setName('Untitled Board');
      setFilePath('');
      setPathTouched(false);
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div className="fixed inset-0 z-[80] bg-black/25 backdrop-blur-[2px] flex items-center justify-center px-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.form onSubmit={handleSubmit} className="w-full max-w-[560px] rounded-[22px] bg-white shadow-[0_28px_90px_rgba(15,18,25,0.22)] border border-white/80 overflow-hidden" initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }} transition={{ duration: 0.2 }}>
            <div className="px-8 pt-7 pb-5 border-b border-gray-100 flex items-start justify-between gap-5">
              <div>
                <div className="text-[20px] font-bold tracking-tight text-black">Create board</div>
                <div className="text-[13.5px] text-[#8f969f] mt-1">Choose a name and the file where this board will be saved.</div>
              </div>
              <button type="button" onClick={onClose} className="h-9 w-9 rounded-xl text-gray-500 hover:bg-gray-100 hover:text-black flex items-center justify-center cursor-pointer" title="Close">
                <X size={18} />
              </button>
            </div>

            <div className="px-8 py-7 space-y-6">
              <label className="block">
                <span className="text-[13px] font-bold text-black mb-2 block">Board name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-[14px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium" autoFocus />
              </label>

              <label className="block">
                <span className="text-[13px] font-bold text-black mb-2 block">Storage path</span>
                <div className="relative">
                  <Folder size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={filePath} onChange={(event) => { setPathTouched(true); setFilePath(event.target.value); }} className="w-full bg-white border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium" />
                </div>
              </label>

              {error && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">{error}</div>}
            </div>

            <div className="px-8 py-5 bg-[#faf9f7] border-t border-gray-100 flex justify-end gap-3">
              <button type="button" onClick={onClose} className={APP_BUTTON_CLASS}>Cancel</button>
              <button type="submit" disabled={isSaving} className={`${APP_BUTTON_CLASS} ${APP_BUTTON_DISABLED_CLASS}`}>
                <Plus size={16} />
                {isSaving ? 'Creating...' : 'Create board'}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function EditorView({
  board,
  initialSnapshot,
  autosave,
  llmConfig,
  onBack,
  onBoardSaved,
  onRenameBoard,
  onDeleteBoard,
}: {
  board: BoardRecord;
  initialSnapshot: BoardSnapshot | null;
  autosave: boolean;
  llmConfig: LLMConfig;
  onBack: () => void;
  onBoardSaved: (board: BoardRecord) => void;
  onRenameBoard: (board: BoardRecord, name: string, snapshot?: BoardSnapshot | null) => Promise<void>;
  onDeleteBoard: (board: BoardRecord, deleteFile: boolean) => Promise<void>;
}) {
  const appWindow = getCurrentWindow();
  const editorRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavedRef = useRef('');
  const [status, setStatus] = useState('Ready');
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(true);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const saveBoard = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;

    const snapshot = getSnapshot(editor.store);
    const serializedSnapshot = JSON.stringify(snapshot);
    if (serializedSnapshot === lastSavedRef.current) return;

    const nextBoard = {
      ...board,
      updatedAt: new Date().toISOString(),
    };
    const payload: BoardFile = {
      version: 1,
      board: nextBoard,
      snapshot,
    };

    setStatus('Saving...');
    await invoke('write_board_file', { path: board.filePath, payload });
    lastSavedRef.current = serializedSnapshot;
    onBoardSaved(nextBoard);
    setStatus('Saved');
  }, [board, onBoardSaved]);

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

      if (initialSnapshot) {
        loadSnapshot(editor.store, initialSnapshot);
        lastSavedRef.current = JSON.stringify(initialSnapshot);
      }

      const unsubscribe = editor.store.listen(
        () => {
          setStatus('Unsaved changes');

          if (!autosave) return;

          if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = window.setTimeout(() => {
            saveBoard().catch((error) => setStatus(String(error)));
          }, 800);
        },
        { source: 'user', scope: 'document' },
      );

      return () => {
        unsubscribe();
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveBoard().catch(() => undefined);
      };
    },
    [autosave, initialSnapshot, saveBoard],
  );

  const applyDiagramToEditor = useCallback((diagram: DiagramSpec) => {
    const editor = editorRef.current;
    if (!editor || !diagram.nodes.length) return;

    const createdShapeIds: string[] = [];
    const baseX = 120;
    const baseY = 250;
    const columnGap = 430;
    const rowGap = 230;
    const nodeLayouts = layoutDiagramNodes(diagram, { baseX, baseY, columnGap, rowGap });

    const nodes = diagram.nodes.map((node, index) => {
      const id = `shape:${crypto.randomUUID()}`;
      createdShapeIds.push(id);

      const layout = nodeLayouts.get(node.id) ?? {
        x: baseX,
        y: baseY + index * rowGap,
        w: defaultNodeSize(node).w,
        h: defaultNodeSize(node).h,
      };

      return {
        id,
        type: 'geo',
        x: layout.x,
        y: layout.y,
        props: {
          geo: node.type === 'database' ? 'ellipse' : node.type === 'decision' ? 'diamond' : node.type === 'note' ? 'cloud' : 'rectangle',
          w: layout.w,
          h: layout.h,
          growY: 0,
          scale: 1,
          color: normalizeTldrawColor(node.color ?? defaultNodeColor(node.type)),
          labelColor: 'black',
          fill: node.type === 'external' || node.type === 'note' ? 'none' : 'semi',
          dash: node.type === 'external' ? 'dashed' : 'solid',
          size: 'm',
          font: 'sans',
          align: 'middle',
          verticalAlign: 'middle',
          url: '',
          richText: toRichText(formatNodeLabel(node)),
        },
      };
    });

    const arrows = cleanDiagramEdges(diagram, nodeLayouts)
      .map((edge) => {
        const from = nodeLayouts.get(edge.from);
        const to = nodeLayouts.get(edge.to);
        if (!from || !to) return null;

        const { start, end } = getArrowEndpoints(from, to);
        const arrowId = `shape:${crypto.randomUUID()}`;
        createdShapeIds.push(arrowId);
        const dx = end.x - start.x;
        const dy = end.y - start.y;

        return {
          id: arrowId,
          type: 'arrow',
          x: start.x,
          y: start.y,
          props: {
            kind: Math.abs(dx) > 80 && Math.abs(dy) > 40 ? 'elbow' : 'arc',
            color: edge.priority === 'security' ? 'red' : edge.priority === 'traffic' ? 'blue' : edge.priority === 'rate-limit' ? 'orange' : 'grey',
            fill: 'none',
            dash: 'solid',
            size: edge.priority === 'traffic' ? 'm' : 's',
            labelColor: 'black',
            font: 'sans',
            arrowheadStart: 'none',
            arrowheadEnd: 'arrow',
            start: { x: 0, y: 0 },
            end: { x: dx, y: dy },
            bend: 0,
            richText: toRichText(shouldShowEdgeLabel(edge, from, to) ? formatEdgeLabel(edge.label) : ''),
            labelPosition: 0.5,
            scale: 1,
            elbowMidPoint: 0.5,
          },
        };
      })
      .filter(Boolean);

    const titleShape = diagram.title
      ? [
          {
            id: `shape:${crypto.randomUUID()}`,
            type: 'geo',
            x: baseX,
            y: 90,
            props: {
              geo: 'rectangle',
              w: Math.min(980, Math.max(520, diagram.title.length * 11)),
              h: 76,
              growY: 0,
              scale: 1,
              color: 'black',
              labelColor: 'black',
              fill: 'none',
              dash: 'solid',
              size: 'm',
              font: 'sans',
              align: 'middle',
              verticalAlign: 'middle',
              url: '',
              richText: toRichText(diagram.title),
            },
          },
        ]
      : [];

    editor.createShapes([...(arrows as any[]), ...(nodes as any[]), ...(titleShape as any[])]);
    editor.select(...createdShapeIds as any[]);
    editor.zoomToSelection({ animation: { duration: 220 } });
    window.setTimeout(() => editor.selectNone(), 260);
  }, []);

  return (
    <div className="h-screen w-full bg-[#f6f5f3] text-black overflow-hidden">
      <div data-tauri-drag-region className="h-12 flex items-center justify-between border-b border-gray-200/80 bg-[#fbfaf8]">
        <div className="h-full flex items-center min-w-0">
          <button onClick={onBack} className={`${APP_BUTTON_CLASS} h-9 px-4 ml-2`} title="Back to boards">
            <ArrowLeft size={18} strokeWidth={1.8} />
            <span className="text-[13.5px] font-bold">Boards</span>
          </button>
          <div className="h-5 w-px bg-gray-200 mx-1" />
          <div className="min-w-0 px-4">
            <div className="text-[14px] font-bold text-black truncate">{board.name}</div>
            <div className="text-[11.5px] font-medium text-[#8f969f] truncate max-w-[52vw]">{board.filePath}</div>
          </div>
        </div>

        <div className="h-full flex items-center">
          <div className="mr-3 flex items-center gap-2 text-[12.5px] font-bold text-[#6b7280]">
            {status === 'Saved' && <CheckCircle2 size={15} className="text-emerald-600" />}
            {status}
          </div>
          <button onClick={() => saveBoard().catch((error) => setStatus(String(error)))} className={`${APP_BUTTON_CLASS} h-9 px-4 mr-3 text-[13px]`} title="Save now">
            <Save size={15} />
            Save
          </button>
          <button onClick={() => setIsRenameDialogOpen(true)} className={`${APP_BUTTON_CLASS} h-9 px-4 mr-3 text-[13px]`} title="Rename board">
            <Edit3 size={15} />
            Rename
          </button>
          <button onClick={() => setIsDeleteDialogOpen(true)} className={`${APP_BUTTON_CLASS} h-9 px-4 mr-3 text-[13px] hover:bg-red-50 hover:text-red-700`} title="Delete board">
            <Trash2 size={15} />
            Delete
          </button>
          <button onClick={() => setIsAiPanelOpen((value) => !value)} className={`${APP_BUTTON_CLASS} h-9 px-4 mr-3 text-[13px]`} title="Show or hide AI panel">
            <Wand2 size={15} />
            {isAiPanelOpen ? 'Hide AI' : 'Show AI'}
          </button>
          <WindowControls appWindow={appWindow} />
        </div>
      </div>

      <div className="h-[calc(100vh-48px)] w-full relative">
        <Tldraw key={board.id} onMount={handleMount} autoFocus />
        <AiBoardPanel isOpen={isAiPanelOpen} llmConfig={llmConfig} onApplyDiagram={applyDiagramToEditor} />
      </div>
      <RenameBoardDialog
        isOpen={isRenameDialogOpen}
        board={board}
        onClose={() => setIsRenameDialogOpen(false)}
        onRename={async (renamedBoard, name) => {
          await onRenameBoard(renamedBoard, name, editorRef.current ? getSnapshot(editorRef.current.store) : undefined);
          setStatus('Saved');
        }}
      />
      <DeleteBoardDialog isOpen={isDeleteDialogOpen} board={board} onClose={() => setIsDeleteDialogOpen(false)} onDelete={onDeleteBoard} />
    </div>
  );
}

type DiagramLayout = { x: number; y: number; w: number; h: number; rank: number };

function defaultNodeSize(node: DiagramNode) {
  if (node.type === 'note') return { w: 330, h: 130 };
  if (node.type === 'database') return { w: 300, h: 120 };
  if (node.type === 'decision') return { w: 280, h: 130 };
  return { w: 300, h: 120 };
}

function layoutDiagramNodes(
  diagram: DiagramSpec,
  options: { baseX: number; baseY: number; columnGap: number; rowGap: number },
) {
  const nodesById = new Map(diagram.nodes.map((node) => [node.id, node]));
  const ranks = new Map<string, number>();

  diagram.nodes.forEach((node) => {
    ranks.set(node.id, classifyNodeRank(node));
  });

  const usableEdges = (diagram.edges ?? []).filter((edge) => nodesById.has(edge.from) && nodesById.has(edge.to));
  for (let pass = 0; pass < Math.min(8, diagram.nodes.length); pass += 1) {
    let changed = false;

    usableEdges.forEach((edge) => {
      const fromRank = ranks.get(edge.from) ?? 0;
      const toRank = ranks.get(edge.to) ?? 0;
      if (fromRank >= 4 && toRank <= 3) return;
      if (edge.priority === 'data' || edge.priority === 'security') return;

      const nextRank = Math.min(5, fromRank + 1);

      if (nextRank > toRank) {
        ranks.set(edge.to, nextRank);
        changed = true;
      }
    });

    if (!changed) break;
  }

  const columns = new Map<number, DiagramNode[]>();
  diagram.nodes.forEach((node) => {
    const rank = ranks.get(node.id) ?? 0;
    const bucket = columns.get(rank) ?? [];
    bucket.push(node);
    columns.set(rank, bucket);
  });

  const maxRows = Math.max(...Array.from(columns.values()).map((items) => items.length), 1);
  const layouts = new Map<string, DiagramLayout>();

  columns.forEach((items, rank) => {
    const sorted = [...items].sort((a, b) => nodeSortScore(a) - nodeSortScore(b));
    const columnHeight = (sorted.length - 1) * options.rowGap;
    const centerOffset = ((maxRows - 1) * options.rowGap - columnHeight) / 2;

    sorted.forEach((node, row) => {
      const size = defaultNodeSize(node);
      layouts.set(node.id, {
        x: options.baseX + rank * options.columnGap,
        y: options.baseY + centerOffset + row * options.rowGap,
        w: size.w,
        h: size.h,
        rank,
      });
    });
  });

  return layouts;
}

function classifyNodeRank(node: DiagramNode) {
  const text = `${node.id} ${node.label} ${node.type ?? ''}`.toLowerCase();

  if (/\b(client|mobile|flutter|web|user|browser|app)\b/.test(text)) return 0;
  if (/\b(google|github|apple|microsoft|otp provider|oauth provider)\b/.test(text)) return 2;
  if (/\b(oauth|otp|auth|identity|supabase|cognito|firebase)\b/.test(text)) return 1;
  if (/\b(waf|cdn|load balancer|gateway|edge|rate)\b/.test(text)) return 2;
  if (/\b(service|controller|api|backend|spring|filter|worker|queue)\b/.test(text)) return 3;
  if (/\b(database|postgres|redis|cache|storage|secret|vault|manager|observability|monitor)\b/.test(text)) return 4;

  switch (node.type) {
    case 'external':
    case 'traffic':
      return 1;
    case 'security':
    case 'rate-limit':
      return 2;
    case 'database':
      return 4;
    default:
      return 3;
  }
}

function nodeSortScore(node: DiagramNode) {
  const text = `${node.label} ${node.type ?? ''}`.toLowerCase();
  if (/\b(client|user|browser|app)\b/.test(text)) return 0;
  if (/\b(edge|waf|cdn|gateway|api)\b/.test(text)) return 10;
  if (/\b(auth|oauth|otp|jwt)\b/.test(text)) return 20;
  if (/\b(rate|security|filter)\b/.test(text)) return 30;
  if (/\b(service|controller|worker)\b/.test(text)) return 40;
  if (/\b(cache|queue|stream)\b/.test(text)) return 50;
  if (/\b(database|postgres|storage|secret|monitor)\b/.test(text)) return 60;
  return 100;
}

function getArrowEndpoints(from: DiagramLayout, to: DiagramLayout) {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? {
          start: { x: from.x + from.w + 18, y: fromCenter.y },
          end: { x: to.x - 18, y: toCenter.y },
        }
      : {
          start: { x: from.x - 18, y: fromCenter.y },
          end: { x: to.x + to.w + 18, y: toCenter.y },
        };
  }

  return dy >= 0
    ? {
        start: { x: fromCenter.x, y: from.y + from.h + 18 },
        end: { x: toCenter.x, y: to.y - 18 },
      }
    : {
        start: { x: fromCenter.x, y: from.y - 18 },
        end: { x: toCenter.x, y: to.y + to.h + 18 },
      };
}

function cleanDiagramEdges(diagram: DiagramSpec, layouts: Map<string, DiagramLayout>) {
  const seenPairs = new Set<string>();
  const connectedIds = new Set<string>();

  const cleanedEdges = (diagram.edges ?? [])
    .filter((edge) => layouts.has(edge.from) && layouts.has(edge.to))
    .filter((edge) => {
      const from = layouts.get(edge.from);
      const to = layouts.get(edge.to);
      if (!from || !to) return false;
      if (edge.from === edge.to) return false;

      const pairKey = `${edge.from}->${edge.to}`;
      if (seenPairs.has(pairKey)) return false;
      seenPairs.add(pairKey);

      return true;
    })
    .slice(0, 24);

  cleanedEdges.forEach((edge) => {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  });

  const syntheticEdges: DiagramEdge[] = [];
  diagram.nodes.forEach((node) => {
    if (connectedIds.has(node.id)) return;

    const target = findConnectionTarget(node, diagram.nodes, layouts);
    if (!target) return;

    const nodeRank = layouts.get(node.id)?.rank ?? 0;
    const targetRank = layouts.get(target.id)?.rank ?? 0;
    const edge =
      nodeRank <= targetRank
        ? { from: node.id, to: target.id, label: '', priority: defaultEdgePriority(node, target) }
        : { from: target.id, to: node.id, label: '', priority: defaultEdgePriority(target, node) };

    const pairKey = `${edge.from}->${edge.to}`;
    if (seenPairs.has(pairKey)) return;

    seenPairs.add(pairKey);
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
    syntheticEdges.push(edge);
  });

  return [...cleanedEdges, ...syntheticEdges].slice(0, 28);
}

function findConnectionTarget(node: DiagramNode, nodes: DiagramNode[], layouts: Map<string, DiagramLayout>) {
  const layout = layouts.get(node.id);
  if (!layout) return null;

  const candidates = nodes
    .filter((candidate) => candidate.id !== node.id && layouts.has(candidate.id))
    .map((candidate) => ({ node: candidate, layout: layouts.get(candidate.id)! }))
    .sort((a, b) => {
      const aRankDistance = Math.abs(a.layout.rank - layout.rank);
      const bRankDistance = Math.abs(b.layout.rank - layout.rank);
      if (aRankDistance !== bRankDistance) return aRankDistance - bRankDistance;

      const aDistance = Math.abs(a.layout.y - layout.y) + Math.abs(a.layout.x - layout.x);
      const bDistance = Math.abs(b.layout.y - layout.y) + Math.abs(b.layout.x - layout.x);
      return aDistance - bDistance;
    });

  return candidates[0]?.node ?? null;
}

function defaultEdgePriority(from: DiagramNode, to: DiagramNode): DiagramEdge['priority'] {
  if (from.type === 'security' || to.type === 'security') return 'security';
  if (from.type === 'database' || to.type === 'database') return 'data';
  if (from.type === 'rate-limit' || to.type === 'rate-limit') return 'rate-limit';
  if (from.type === 'traffic' || to.type === 'traffic') return 'traffic';

  return 'control';
}

function shouldShowEdgeLabel(edge: DiagramEdge, from: DiagramLayout, to: DiagramLayout) {
  const label = formatEdgeLabel(edge.label);
  const noisyLabelPattern = /\b(return|response|persist|store token|save token|provide|load|query|pass uuid|prompt|callback)\b/i;
  if (!label) return false;
  if (noisyLabelPattern.test(label)) return false;
  if (label.length > 18) return false;
  if (Math.abs(from.rank - to.rank) > 1) return false;
  if (Math.abs((from.y + from.h / 2) - (to.y + to.h / 2)) > 80) return false;

  return true;
}

function formatNodeLabel(node: DiagramNode) {
  const label = node.label.trim();
  const detail = node.detail?.trim();
  if (!detail) return label;

  return `${label}\n${detail}`;
}

function formatEdgeLabel(label?: string) {
  const cleanLabel = (label ?? '').replace(/^\d+\.\s*/, '').trim();
  if (cleanLabel.length <= 22) return cleanLabel;

  return `${cleanLabel.slice(0, 19).trim()}...`;
}

function normalizeTldrawColor(value?: string) {
  const color = (value ?? '').toLowerCase();
  const allowed = ['black', 'blue', 'green', 'grey', 'light-blue', 'light-green', 'light-red', 'light-violet', 'orange', 'red', 'violet', 'yellow'];
  return allowed.includes(color) ? color : 'blue';
}

function defaultNodeColor(type?: DiagramNode['type']) {
  switch (type) {
    case 'security':
      return 'red';
    case 'rate-limit':
      return 'orange';
    case 'traffic':
      return 'blue';
    case 'database':
      return 'green';
    case 'external':
      return 'grey';
    case 'decision':
      return 'violet';
    default:
      return 'blue';
  }
}

function extractDiagramSpec(content: string): DiagramSpec {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced?.[1] ?? content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText) as DiagramSpec;

  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error('AI response did not include diagram nodes.');
  }

  return {
    title: parsed.title,
    nodes: parsed.nodes.slice(0, 24).map((node, index) => ({
      id: String(node.id || `node-${index + 1}`),
      label: String(node.label || `Node ${index + 1}`),
      detail: node.detail ? String(node.detail) : undefined,
      type: node.type,
      x: typeof node.x === 'number' ? node.x : undefined,
      y: typeof node.y === 'number' ? node.y : undefined,
      w: typeof node.w === 'number' ? node.w : undefined,
      h: typeof node.h === 'number' ? node.h : undefined,
      color: node.color,
    })),
    edges: Array.isArray(parsed.edges)
      ? parsed.edges.slice(0, 40).map((edge) => ({
          from: String(edge.from),
          to: String(edge.to),
          label: edge.label ? String(edge.label) : undefined,
          priority: edge.priority,
        }))
      : [],
  };
}

function AiBoardPanel({ isOpen, llmConfig, onApplyDiagram }: { isOpen: boolean; llmConfig: LLMConfig; onApplyDiagram: (diagram: DiagramSpec) => void }) {
  const [activeConfig, setActiveConfig] = useState(llmConfig);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: 'Describe the system, workflow, architecture, or diagram you want. I will generate it directly on the board.',
    },
  ]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [workStepIndex, setWorkStepIndex] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    setActiveConfig(llmConfig);
  }, [llmConfig]);

  useEffect(() => {
    if (!isGenerating) {
      setWorkStepIndex(0);
      return undefined;
    }

    const timer = window.setInterval(() => {
      setWorkStepIndex((current) => (current + 1) % AGENT_WORK_STEPS.length);
    }, 1400);

    return () => window.clearInterval(timer);
  }, [isGenerating]);

  const updatePanelProvider = (provider: string) => {
    const preset = PROVIDER_PRESETS[provider];
    setActiveConfig((current) => ({
      ...current,
      provider,
      endpoint: preset?.endpoint ?? current.endpoint,
      modelName: preset?.modelName ?? current.modelName,
    }));
  };

  const canGenerate = activeConfig.enabled && activeConfig.modelName.trim() && activeConfig.endpoint.trim() && prompt.trim() && !isGenerating;

  const handleGenerate = async () => {
    if (!canGenerate) {
      setError(activeConfig.enabled ? 'Enter a prompt before generating.' : 'Enable and save an LLM provider in the LLM settings first.');
      return;
    }

    const userMessage: ChatMessage = { role: 'user', content: prompt.trim() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setPrompt('');
    setError('');
    setIsGenerating(true);

    try {
      const response = await invoke<{ content: string }>('call_llm', {
        request: {
          provider: activeConfig.provider,
          endpoint: activeConfig.endpoint,
          model: activeConfig.modelName,
          apiKey: activeConfig.apiKey,
          temperature: activeConfig.temperature,
          systemPrompt: [
            'You are a senior system design architect and diagram generation agent for a tldraw whiteboard.',
            'Return JSON only. No markdown, no explanation.',
            'Schema: {"title":"string","nodes":[{"id":"short-kebab-id","label":"string","detail":"short responsibility, max 6 words","type":"process|database|external|decision|note|security|rate-limit|traffic","color":"blue|green|orange|red|violet|grey|yellow"}],"edges":[{"from":"node id","to":"node id","label":"string","priority":"security|traffic|rate-limit|data|control"}]}.',
            'Create clean production-grade architecture diagrams, not sequence diagrams. Use component names as node labels, short responsibilities as node detail, and short action names as edge labels.',
            'Do not number labels. Do not include step numbers in nodes or edges. Keep node labels under 4 words, node details under 6 words, and edge labels under 3 words.',
            'Prefer left-to-right system flow: client/user, identity/external providers, edge/gateway/security, backend/services, data stores/operations.',
            'For auth flows, keep login providers near auth, backend services in the service lane, and databases/secrets/observability in the data/ops lane.',
            'Every node must have at least one edge. Include dependency edges for secure storage, secret manager, databases, caches, queues, observability, and external providers when those nodes exist.',
            'Include important production components and security boundaries. Avoid duplicate nodes and avoid micro-steps like "return response" unless they change a security or data boundary.',
            'Use 10 to 16 nodes by default. Use security/red for auth checks, filters, WAF, secrets, and JWT verification. Use traffic/blue for clients, gateways, and routers. Use database/green for persistent stores.',
          ].join('\n'),
          messages: nextMessages.map((message) => ({ role: message.role, content: message.content })),
        },
      });

      const diagram = extractDiagramSpec(response.content);
      onApplyDiagram(diagram);
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: `Created ${diagram.nodes.length} nodes and ${diagram.edges?.length ?? 0} connections${diagram.title ? ` for ${diagram.title}` : ''}.`,
        },
      ]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      setMessages((current) => [...current, { role: 'assistant', content: 'I could not generate a valid diagram. Adjust the prompt or provider configuration and try again.' }]);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 18 }} className="ai-board-panel z-[60] rounded-2xl border border-gray-200/80 bg-white shadow-[0_18px_60px_rgba(15,18,25,0.18)] overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[14px] font-bold text-black">
                <Wand2 size={16} />
                AI diagram agent
              </div>
              <div className="text-[12px] font-medium text-[#8f969f] truncate">{activeConfig.enabled ? `${activeConfig.provider} / ${activeConfig.modelName}` : 'Configure LLM settings first'}</div>
            </div>
            <div className="h-9 px-3 rounded-xl bg-[#faf9f7] border border-gray-100 flex items-center text-[11.5px] font-bold text-[#8f969f]">System design</div>
          </div>

          <div className="px-5 py-4 border-b border-gray-100 space-y-3">
            <div className="grid grid-cols-[0.85fr_1.15fr] gap-3">
              <label>
                <span className="block text-[11.5px] font-bold text-[#8f969f] mb-1.5">Provider</span>
                <select value={activeConfig.provider} onChange={(event) => updatePanelProvider(event.target.value)} className="w-full min-w-0 bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[12.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-bold">
                  {Object.keys(PROVIDER_PRESETS).map((provider) => (
                    <option key={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="block text-[11.5px] font-bold text-[#8f969f] mb-1.5">Model</span>
                <input value={activeConfig.modelName} onChange={(event) => setActiveConfig((current) => ({ ...current, modelName: event.target.value }))} className="w-full min-w-0 bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[12.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-bold" />
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <PanelPill icon={<ShieldCheck size={13} />} label="Security" />
              <PanelPill icon={<Gauge size={13} />} label="Traffic" />
              <PanelPill icon={<Zap size={13} />} label="Rate limits" />
            </div>
          </div>

          <div className="h-[260px] overflow-y-auto hide-scrollbar px-5 py-4 space-y-3 bg-[#fbfaf8]">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`rounded-xl px-4 py-3 text-[13px] leading-5 font-medium ${message.role === 'user' ? 'bg-black text-white ml-8' : 'bg-white border border-gray-100 text-gray-800 mr-8'}`}>
                {message.content}
              </div>
            ))}
            {isGenerating && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-blue-100 bg-white px-4 py-3 mr-8 shadow-[0_8px_24px_rgba(37,99,235,0.08)]">
                <div className="flex items-center gap-2 text-[13px] font-bold text-black">
                  <LoaderCircle size={15} className="animate-spin text-blue-600" />
                  Agent working
                </div>
                <div className="mt-2 text-[12.5px] font-medium text-[#6b7280]">{AGENT_WORK_STEPS[workStepIndex]}</div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
                  <motion.div
                    className="h-full rounded-full bg-blue-600"
                    initial={{ x: '-100%' }}
                    animate={{ x: '100%' }}
                    transition={{ duration: 1.25, repeat: Infinity, ease: 'easeInOut' }}
                  />
                </div>
              </motion.div>
            )}
            {error && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12.5px] font-medium text-red-700">{error}</div>}
          </div>

          <div className="p-4 border-t border-gray-100">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={isGenerating} placeholder={isGenerating ? 'Agent is generating the diagram...' : 'Design a detailed system architecture for a high-traffic payment app with authentication, WAF, API gateway, rate limiting, queues, cache, database, monitoring, and security boundaries...'} className="h-28 w-full resize-none bg-white border border-gray-200 rounded-xl px-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium placeholder-gray-400 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed" />
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="text-[11.5px] font-bold text-[#8f969f]">{isGenerating ? AGENT_WORK_STEPS[workStepIndex] : activeConfig.enabled ? 'Creates shapes on this board' : 'LLM disabled'}</div>
              <button onClick={handleGenerate} disabled={!canGenerate} className={`${APP_BUTTON_CLASS} ${APP_BUTTON_DISABLED_CLASS}`}>
                {isGenerating ? <LoaderCircle size={15} className="animate-spin" /> : <Wand2 size={15} />}
                {isGenerating ? 'Designing...' : 'Design'}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PanelPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="rounded-xl bg-[#faf9f7] border border-gray-100 px-3 py-2 flex items-center justify-center gap-1.5 text-[11.5px] font-bold text-[#6b7280]">
      {icon}
      {label}
    </div>
  );
}

function SettingsView({ settings, onSave }: { settings: AppSettings; onSave: (settings: AppSettings) => void }) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const updateDraft = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSave = () => {
    onSave({ ...draft, defaultBoardFolder: draft.defaultBoardFolder.trim() });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex-1 flex flex-col p-12 pr-8 pb-0 min-w-0">
      <div className="mb-10 flex items-start justify-between gap-8">
        <div>
          <div className="text-[18px] text-black font-medium tracking-tight">Settings</div>
          <div className="text-[13.5px] text-[#8f969f] font-medium mt-1">Workspace preferences and local storage behavior.</div>
        </div>
        <button onClick={handleSave} className={APP_BUTTON_CLASS}>
          {saved ? <CheckCircle2 size={16} /> : <Save size={16} />}
          {saved ? 'Saved' : 'Save changes'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto hide-scrollbar pb-12 pr-2">
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)] gap-5 max-xl:grid-cols-1">
          <div className="space-y-5">
            <SettingsSection title="Appearance" icon={<SlidersHorizontal size={18} />}>
              <div className="flex items-center justify-between gap-6 py-1">
                <div>
                  <div className="text-[15px] text-black font-semibold mb-1">Application theme</div>
                  <div className="text-[13.5px] text-[#8f969f] font-medium">Controls the shell, dialogs, and navigation surface.</div>
                </div>

                <div className="flex bg-[#f3f4f6] p-1 rounded-xl border border-gray-100 shrink-0">
                  <button onClick={() => updateDraft('theme', 'light')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13.5px] font-bold transition-all cursor-pointer ${draft.theme === 'light' ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] text-black' : 'text-gray-500 hover:text-black'}`}>
                    <Sun size={16} strokeWidth={2} /> Light
                  </button>
                  <button onClick={() => updateDraft('theme', 'dark')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13.5px] font-bold transition-all cursor-pointer ${draft.theme === 'dark' ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] text-black' : 'text-gray-500 hover:text-black'}`}>
                    <Moon size={16} strokeWidth={2} /> Dark
                  </button>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title="Storage" icon={<HardDrive size={18} />}>
              <label className="block">
                <span className="text-[13px] font-bold text-black mb-2 block">Default board folder</span>
                <div className="relative">
                  <Folder size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={draft.defaultBoardFolder} onChange={(event) => updateDraft('defaultBoardFolder', event.target.value)} placeholder="Leave empty for Documents\\Tldraw Boards" className="w-full bg-white border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium placeholder-gray-400" />
                </div>
              </label>

              <div className="mt-6 divide-y divide-gray-100">
                <ToggleRow title="Auto-save board files" description="Writes drawing updates back to the selected board file." checked={draft.autosave} onChange={(value) => updateDraft('autosave', value)} />
                <ToggleRow title="Confirm before overwrite" description="Ask before creating a board at an existing file path." checked={draft.confirmOverwrite} onChange={(value) => updateDraft('confirmOverwrite', value)} />
                <ToggleRow title="Open last board on launch" description="Return directly to the most recently edited board." checked={draft.openLastBoard} onChange={(value) => updateDraft('openLastBoard', value)} />
              </div>
            </SettingsSection>
          </div>

          <div className="space-y-5">
            <SettingsSection title="Local app state" icon={<Database size={18} />}>
              <div className="space-y-4">
                <InfoStat label="Metadata store" value="localStorage" />
                <InfoStat label="Board files" value=".tldr.json" />
                <InfoStat label="Sync mode" value="Local only" />
              </div>
            </SettingsSection>

            <SettingsSection title="Security" icon={<ShieldCheck size={18} />}>
              <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-4">
                <div className="flex items-center gap-2 text-[13.5px] font-bold text-emerald-800">
                  <CheckCircle2 size={16} />
                  Local file workflow
                </div>
                <div className="text-[12.5px] leading-5 text-emerald-800/75 font-medium mt-2">
                  Board metadata stays in this app. Drawing snapshots are saved to the path selected when each board is created.
                </div>
              </div>
            </SettingsSection>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function UpdatesView() {
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [status, setStatus] = useState('Ready to check');
  const [error, setError] = useState('');
  const [isChecking, setIsChecking] = useState(false);

  const handleCheckUpdates = async () => {
    setIsChecking(true);
    setError('');
    setStatus('Checking GitHub releases...');

    try {
      const result = await invoke<UpdateCheck>('check_for_updates');
      setUpdate(result);
      setStatus(result.updateAvailable ? `Version ${result.latestVersion} is available` : 'You are up to date');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      setStatus('Could not check for updates');
    } finally {
      setIsChecking(false);
    }
  };

  const handleOpenRelease = async () => {
    if (!update?.releaseUrl) return;
    await openUrl(update.releaseUrl);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex-1 flex flex-col p-12 pr-8 pb-0 min-w-0">
      <div className="mb-10 flex items-center text-[18px] text-black font-medium tracking-tight">Updates</div>

      <div className="w-full h-[180px] rounded-2xl overflow-hidden relative mb-12 shrink-0 group cursor-pointer">
        <div className="absolute inset-0 bg-[#0f0e0c] transition-transform duration-700 group-hover:scale-[1.02]">
          <div className="absolute right-0 top-0 bottom-0 w-1/2">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-[#9fbac3]/30 via-[#3c525f]/20 to-transparent blur-xl" />
          </div>
          <div className="absolute inset-0 bg-gradient-to-r from-[#0f0e0c] via-[#0f0e0c]/90 to-transparent" />
        </div>

        <div className="absolute inset-0 p-8 px-10 flex flex-col justify-center">
          <h2 className="text-white font-serif-elegant text-[32px] mb-2 tracking-tight transition-transform duration-500 group-hover:translate-x-1">
            {update?.updateAvailable ? 'A new Tldraw update is available' : update ? 'Tldraw is up to date' : 'Check for Tldraw updates'}
          </h2>
          <p className="text-white/80 text-[15px] mb-6 font-medium tracking-wide transition-transform duration-500 group-hover:translate-x-1">
            {update
              ? `Current ${update.currentVersion} · Latest ${update.latestVersion}`
              : 'Updates are published from GitHub Releases.'}
          </p>

          <div className="flex items-center gap-3">
            <button onClick={handleCheckUpdates} disabled={isChecking} className={`${APP_BUTTON_CLASS} ${APP_BUTTON_DISABLED_CLASS} w-fit`}>
              <RefreshCw size={15} className={isChecking ? 'animate-spin' : ''} />
              {isChecking ? 'Checking...' : 'Check for updates'}
            </button>
            {update?.updateAvailable && (
              <button onClick={handleOpenRelease} className={`${APP_BUTTON_CLASS} w-fit`}>
                <ArrowRight size={15} />
                Update now
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-3xl rounded-2xl border border-gray-100/80 bg-white p-7 shadow-[0_2px_10px_rgba(0,0,0,0.01)]">
        <div className="text-[12px] font-bold tracking-[0.1em] uppercase text-[#9ca3af] mb-3">Release status</div>
        <div className="text-[15px] font-semibold text-black">{status}</div>
        {update?.releaseName && <div className="mt-2 text-[13.5px] font-medium text-[#6b7280]">{update.releaseName}</div>}
        {error && <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">{error}</div>}
      </div>
    </motion.div>
  );
}

function LLMView({ config, onSave }: { config: LLMConfig; onSave: (config: LLMConfig) => void }) {
  const [draft, setDraft] = useState(config);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testStatus, setTestStatus] = useState('Not tested');

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const updateDraft = <Key extends keyof LLMConfig>(key: Key, value: LLMConfig[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setError('');
    setTestStatus('Not tested');
  };

  const updateProvider = (provider: string) => {
    const preset = PROVIDER_PRESETS[provider];
    setDraft((current) => ({
      ...current,
      provider,
      endpoint: preset?.endpoint ?? current.endpoint,
      modelName: preset?.modelName ?? current.modelName,
    }));
    setSaved(false);
    setError('');
    setTestStatus('Not tested');
  };

  const handleSave = () => {
    setError('');

    if (draft.enabled) {
      if (!draft.modelName.trim()) {
        setError('Model name is required when Custom LLM is enabled.');
        return;
      }

      try {
        new URL(draft.endpoint);
      } catch {
        setError('Endpoint URL must be a valid URL.');
        return;
      }
    }

    onSave({
      ...draft,
      modelName: draft.modelName.trim(),
      endpoint: draft.endpoint.trim(),
      apiKey: draft.apiKey.trim(),
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const handleTestConnection = async () => {
    setError('');

    try {
      new URL(draft.endpoint);
    } catch {
      setError('Endpoint URL must be valid before testing.');
      return;
    }

    setTestStatus('Checking...');

    try {
      await invoke<{ content: string }>('call_llm', {
        request: {
          provider: draft.provider,
          endpoint: draft.endpoint,
          model: draft.modelName,
          apiKey: draft.apiKey,
          temperature: 0,
          systemPrompt: 'Reply with exactly OK.',
          messages: [{ role: 'user', content: 'Connection test' }],
        },
      });
      setTestStatus('Reachable');
    } catch {
      setTestStatus('Unavailable');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex-1 flex flex-col p-12 pr-8 pb-0 min-w-0">
      <div className="mb-10 flex items-start justify-between gap-8">
        <div>
          <div className="text-[18px] text-black font-medium tracking-tight">Custom LLM</div>
          <div className="text-[13.5px] text-[#8f969f] font-medium mt-1">Configure the assistant model used by future board intelligence features.</div>
        </div>
        <button onClick={handleSave} className={APP_BUTTON_CLASS}>
          {saved ? <CheckCircle2 size={16} /> : <Save size={16} />}
          {saved ? 'Saved' : 'Save configuration'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto hide-scrollbar pb-12 pr-2">
        <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)] gap-5 max-xl:grid-cols-1">
          <div className="space-y-5">
            <SettingsSection title="Connection" icon={<Bot size={18} />}>
              <ToggleRow title="Enable custom LLM" description="Use this model configuration for AI-assisted board actions." checked={draft.enabled} onChange={(value) => updateDraft('enabled', value)} />

              <div className="grid grid-cols-2 gap-4 mt-6 max-md:grid-cols-1">
                <label className="block">
                  <span className="text-[13px] font-bold text-black mb-2 block">Provider</span>
                  <select value={draft.provider} onChange={(event) => updateProvider(event.target.value)} className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium">
                    <option>OpenAI</option>
                    <option>Gemini</option>
                    <option>Claude</option>
                    <option>OpenAI compatible</option>
                    <option>Ollama</option>
                    <option>Local server</option>
                  </select>
                </label>

                <label className="block">
                  <span className="text-[13px] font-bold text-black mb-2 block">Model name</span>
                  <input value={draft.modelName} onChange={(event) => updateDraft('modelName', event.target.value)} type="text" placeholder="e.g. llama3.1:8b" className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium placeholder-gray-400" />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-4 mt-6 max-md:grid-cols-1">
                <label className="block">
                  <span className="text-[13px] font-bold text-black mb-2 block">Endpoint URL</span>
                  <div className="relative">
                    <Link size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input value={draft.endpoint} onChange={(event) => updateDraft('endpoint', event.target.value)} type="url" placeholder="http://localhost:11434/v1" className="w-full bg-white border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium placeholder-gray-400" />
                  </div>
                </label>

                <label className="block">
                  <span className="text-[13px] font-bold text-black mb-2 block">API key</span>
                  <div className="relative">
                    <KeyRound size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input value={draft.apiKey} onChange={(event) => updateDraft('apiKey', event.target.value)} type="password" placeholder="Optional for local models" className="w-full bg-white border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-[13.5px] outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all text-black font-medium font-mono placeholder-gray-400" />
                  </div>
                </label>
              </div>

              {error && <div className="mt-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">{error}</div>}

              <div className="mt-6 flex items-center gap-3">
                <button onClick={handleTestConnection} className={APP_BUTTON_CLASS}>
                  <Zap size={15} />
                  Test endpoint
                </button>
                <div className="text-[12.5px] font-bold text-[#8f969f]">{testStatus}</div>
              </div>
            </SettingsSection>

            <SettingsSection title="Generation" icon={<Gauge size={18} />}>
              <div className="flex items-center justify-between gap-8">
                <div>
                  <div className="text-[15px] text-black font-semibold mb-1">Temperature</div>
                  <div className="text-[13.5px] text-[#8f969f] font-medium">Lower values keep board suggestions more deterministic.</div>
                </div>
                <div className="w-[260px] shrink-0">
                  <div className="flex items-center justify-between text-[12.5px] font-bold text-[#8f969f] mb-2">
                    <span>Precise</span>
                    <span className="text-black">{draft.temperature.toFixed(1)}</span>
                    <span>Creative</span>
                  </div>
                  <input value={draft.temperature} onChange={(event) => updateDraft('temperature', Number(event.target.value))} type="range" min="0" max="1" step="0.1" className="w-full accent-black" />
                </div>
              </div>
            </SettingsSection>
          </div>

          <div className="space-y-5">
            <SettingsSection title="Status" icon={<Zap size={18} />}>
              <div className={`rounded-xl border px-4 py-4 ${draft.enabled ? 'border-emerald-100 bg-emerald-50' : 'border-gray-100 bg-[#faf9f7]'}`}>
                <div className={`flex items-center gap-2 text-[13.5px] font-bold ${draft.enabled ? 'text-emerald-800' : 'text-gray-700'}`}>
                  {draft.enabled ? <CheckCircle2 size={16} /> : <BrainCircuit size={16} />}
                  {draft.enabled ? 'Custom LLM enabled' : 'Custom LLM inactive'}
                </div>
                <div className={`text-[12.5px] leading-5 font-medium mt-2 ${draft.enabled ? 'text-emerald-800/75' : 'text-[#8f969f]'}`}>
                  {draft.enabled ? `${draft.provider} will use ${draft.modelName || 'the selected model'}.` : 'Enable the configuration when you are ready to connect a model.'}
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title="Runtime" icon={<Database size={18} />}>
              <div className="space-y-4">
                <InfoStat label="Provider" value={draft.provider} />
                <InfoStat label="Model" value={draft.modelName || 'Not set'} />
                <InfoStat label="Key" value={draft.apiKey ? 'Stored locally' : 'Not set'} />
              </div>
            </SettingsSection>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function SettingsSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border border-gray-100/80 rounded-2xl shadow-[0_2px_10px_rgba(0,0,0,0.01)] bg-white p-7">
      <div className="flex items-center gap-2 text-[#9ca3af] text-[12px] font-bold tracking-[0.1em] uppercase mb-6">
        <span className="h-8 w-8 rounded-xl bg-[#f4f0ea] text-black flex items-center justify-center">{icon}</span>
        {title}
      </div>
      {children}
    </section>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-6 py-5 first:pt-0 last:pb-0">
      <div>
        <div className="text-[15px] text-black font-semibold mb-1">{title}</div>
        <div className="text-[13.5px] text-[#8f969f] font-medium">{description}</div>
      </div>
      <button onClick={() => onChange(!checked)} className={`w-[46px] h-[26px] rounded-full p-[3px] shrink-0 transition-colors cursor-pointer ${checked ? 'bg-black' : 'bg-gray-200'}`} role="switch" aria-checked={checked}>
        <span className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

function InfoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-[#faf9f7] border border-gray-100 px-4 py-3">
      <span className="text-[12.5px] font-bold text-[#8f969f]">{label}</span>
      <span className="text-[13px] font-bold text-black truncate">{value}</span>
    </div>
  );
}
