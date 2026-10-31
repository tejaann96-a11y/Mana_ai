import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar'
import { ChatMessage } from './components/ChatMessage'
import { ChatInput } from './components/ChatInput'
import { SettingsModal } from './components/SettingsModal'
import { MemoryModal } from './components/MemoryModal'
import { AuthModal } from './components/AuthModal'
import { ManaLogo } from './components/ManaLogo'
import { ImageLightboxModal } from './components/ImageLightboxModal'
import {
  Message,
  AppConfig,
  SearchMode,
  ChatSessionSummary,
  AuthUser,
  ChatMode,
  GeneratedImageMetadata,
  VideoJobMetadata,
  ConversationFileAttachment,
  StagedFileAttachment,
} from './types/chat'
import {
  voiceManager,
  isSpeechRecognitionSupported,
  DEFAULT_VOICE_SETTINGS,
} from './utils/voiceManager'
import { safeApiFetch } from './utils/api'
import { initTheme } from './utils/themeManager'

export const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 820)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isMemoryOpen, setIsMemoryOpen] = useState(false)
  const [isAuthOpen, setIsAuthOpen] = useState(false)

  // Mode & Media Generation state
  const [chatMode, setChatMode] = useState<ChatMode>('chat')
  const [imageAspectRatio, setImageAspectRatio] = useState<'1:1' | '16:9' | '9:16'>('1:1')
  const [imageQuality, setImageQuality] = useState<'standard' | 'hd'>('standard')
  const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [videoDuration, setVideoDuration] = useState<number>(5)
  const [lightboxImage, setLightboxImage] = useState<GeneratedImageMetadata | null>(null)

  // Voice Assistant state
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  // Auth state
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)

  // Chat sessions & history state
  const [sessions, setSessions] = useState<ChatSessionSummary[]>(() => {
    try {
      const cached = localStorage.getItem('mana_cached_sessions')
      return cached ? JSON.parse(cached) : []
    } catch {
      return []
    }
  })
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  const [stagedAttachments, setStagedAttachments] = useState<StagedFileAttachment[]>([])
  const uploadSessionPromiseRef = useRef<Promise<string> | null>(null)

  const [config, setConfig] = useState<AppConfig>({
    aiProvider: 'ollama',
    searchProvider: 'duckduckgo',
    searchMode: 'auto',
    modelName: 'qwen2.5:3b',
    systemPrompt: '',
    maxShortSentences: 4,
    emojiDensity: 'concise',
    voiceSettings: DEFAULT_VOICE_SETTINGS,
  })

  const configRef = useRef(config)
  useEffect(() => {
    configRef.current = config
  }, [config])

  // Initialize theme mode and system preference listener
  useEffect(() => {
    return initTheme()
  }, [])

  const isSpeakingRef = useRef(false)
  const speakingMessageIdRef = useRef<string | null>(null)
  const isListeningRef = useRef(false)

  useEffect(() => {
    isSpeakingRef.current = isSpeaking
  }, [isSpeaking])

  useEffect(() => {
    speakingMessageIdRef.current = speakingMessageId
  }, [speakingMessageId])

  useEffect(() => {
    isListeningRef.current = isListening
  }, [isListening])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isGeneratingRef = useRef(false)

  // Clean up any ongoing speech or microphone capture on unmount
  useEffect(() => {
    return () => {
      voiceManager.stopSpeaking()
      voiceManager.stopListening()
    }
  }, [])

  // Keep ref in sync
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  // Helper for auth and client isolation headers
  const getAuthHeaders = useCallback((): HeadersInit => {
    const token = authToken || localStorage.getItem('mana_auth_token')
    let guestId = localStorage.getItem('mana_guest_id')
    if (!guestId) {
      guestId = `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      localStorage.setItem('mana_guest_id', guestId)
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-guest-id': guestId,
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return headers
  }, [authToken])

  // Load chat sessions from backend
  const fetchSessions = useCallback(async () => {
    try {
      const allSessions: ChatSessionSummary[] = []
      let loaded = false
      const pageSize = 100
      let offset = 0
      while (true) {
        const res = await safeApiFetch<{
          sessions: ChatSessionSummary[]
          hasMore?: boolean
        }>(`/api/chats?limit=${pageSize}&offset=${offset}`, {
          headers: getAuthHeaders(),
        })
        if (!res.success || !res.data?.sessions || !Array.isArray(res.data.sessions)) break
        loaded = true
        allSessions.push(...res.data.sessions)
        if (!res.data.hasMore || res.data.sessions.length === 0) break
        offset += res.data.sessions.length
      }
      if (loaded) {
        setSessions(allSessions)
        try {
          localStorage.setItem('mana_cached_sessions', JSON.stringify(allSessions))
        } catch {}
      }
    } catch (err) {
      console.warn('Could not load chat sessions:', err)
    }
  }, [getAuthHeaders])

  const ensureSessionForUpload = async (): Promise<string> => {
    if (currentSessionIdRef.current) return currentSessionIdRef.current
    if (uploadSessionPromiseRef.current) return uploadSessionPromiseRef.current
    const creation = safeApiFetch<{ session: ChatSessionSummary }>('/api/chats', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ title: 'File analysis' }),
    }).then((result) => {
      if (!result.success || !result.data?.session?.id) {
        throw new Error(result.error || 'Could not create a conversation for this upload.')
      }
      const session = result.data.session
      setCurrentSessionId(session.id)
      currentSessionIdRef.current = session.id
      localStorage.setItem('mana_active_session_id', session.id)
      setSessions((previous) => [session, ...previous.filter((item) => item.id !== session.id)])
      void fetchSessions()
      return session.id
    }).finally(() => {
      uploadSessionPromiseRef.current = null
    })
    uploadSessionPromiseRef.current = creation
    return creation
  }

  const handleUploadFiles = async (files: File[]) => {
    const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
    const uploadsAreLocal = localHosts.has(window.location.hostname.replace(/^\[|\]$/g, '').toLowerCase())
    const allowedExtensions = new Set([
      '.png', '.jpg', '.jpeg', '.webp', '.pdf', '.docx', '.doc',
      '.xlsx', '.xls', '.csv', '.txt', '.md',
    ])
    const maxFiles = 5
    const maxBytes = 15 * 1024 * 1024
    const availableSlots = Math.max(0, maxFiles - stagedAttachments.filter((item) => item.status !== 'failed').length)
    if (!files.length) return

    const selected = files.slice(0, availableSlots)
    const rejected = files.slice(availableSlots)
    const toUpload = selected.map((file): { file: File; attachment: StagedFileAttachment } => {
      const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      const attachment: StagedFileAttachment = {
        id,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        status: 'uploading',
        progress: 0,
        previewUrl,
      }
      const validationError = !allowedExtensions.has(extension)
        ? 'Unsupported file format'
        : file.size > maxBytes
          ? 'File exceeds the 15 MB limit'
          : !uploadsAreLocal
            ? 'Run Mana AI locally to upload private files'
          : undefined
      if (validationError) {
        attachment.status = 'failed'
        attachment.error = validationError
      }
      return { file, attachment }
    })
    const rejectedItems = rejected.map((file): StagedFileAttachment => ({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      status: 'failed',
      progress: 0,
      error: 'A maximum of 5 files can be staged at once',
    }))
    setStagedAttachments((previous) => [...previous, ...toUpload.map(({ attachment }) => attachment), ...rejectedItems])

    const uploadOne = async ({ file, attachment }: (typeof toUpload)[number]) => {
      if (attachment.status === 'failed') return
      try {
        const sessionId = await ensureSessionForUpload()
        setStagedAttachments((previous) =>
          previous.map((item) => item.id === attachment.id ? { ...item, sessionId } : item)
        )
        await new Promise<void>((resolve, reject) => {
          const request = new XMLHttpRequest()
          request.open('POST', `/api/chats/${encodeURIComponent(sessionId)}/files`)
          const headers = new Headers(getAuthHeaders())
          headers.delete('Content-Type')
          headers.forEach((value, name) => request.setRequestHeader(name, value))
          request.upload.onprogress = (event) => {
            if (!event.lengthComputable) return
            const progress = Math.round((event.loaded / event.total) * 100)
            setStagedAttachments((previous) =>
              previous.map((item) => item.id === attachment.id ? { ...item, progress } : item)
            )
          }
          request.onerror = () => reject(new Error('Network error while uploading this file.'))
          request.onload = () => {
            let response: { file?: ConversationFileAttachment; error?: string }
            try {
              response = JSON.parse(request.responseText)
            } catch {
              reject(new Error('The server returned an invalid upload response.'))
              return
            }
            if (request.status < 200 || request.status >= 300 || !response.file) {
              reject(new Error(response.error || `Upload failed (HTTP ${request.status}).`))
              return
            }
            setStagedAttachments((previous) =>
              previous.map((item) =>
                item.id === attachment.id
                  ? { ...response.file!, status: 'complete', progress: 100, previewUrl: item.previewUrl, sessionId }
                  : item
              )
            )
            resolve()
          }
          const form = new FormData()
          form.append('file', file, file.name)
          request.send(form)
        })
      } catch (error) {
        setStagedAttachments((previous) =>
          previous.map((item) =>
            item.id === attachment.id
              ? { ...item, status: 'failed', error: error instanceof Error ? error.message : 'Upload failed.' }
              : item
          )
        )
      }
    }

    await Promise.all(toUpload.map(uploadOne))
  }

  const handleRemoveAttachment = async (attachment: StagedFileAttachment) => {
    const sessionId = attachment.sessionId || currentSessionIdRef.current
    if (sessionId && !attachment.id.startsWith('upload-')) {
      try {
        const result = await safeApiFetch<{ success: boolean }>(
          `/api/chats/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(attachment.id)}`,
          { method: 'DELETE', headers: getAuthHeaders() }
        )
        if (!result.success || !result.data?.success) {
          throw new Error(result.error || 'The server did not remove the uploaded file.')
        }
      } catch (error) {
        setStagedAttachments((previous) =>
          previous.map((item) =>
            item.id === attachment.id
              ? { ...item, status: 'failed', error: error instanceof Error ? error.message : 'Could not remove the uploaded file.' }
              : item
          )
        )
        return
      }
    }
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    setStagedAttachments((previous) => previous.filter((item) => item.id !== attachment.id))
  }

  const clearStagedAttachments = () => {
    setStagedAttachments((previous) => {
      previous.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      })
      return []
    })
  }

  // Verify auth token on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('mana_auth_token')
    const savedUser = localStorage.getItem('mana_user')

    if (savedToken) {
      setAuthToken(savedToken)
      if (savedUser) {
        try {
          setCurrentUser(JSON.parse(savedUser))
        } catch {
          // ignore
        }
      }

      safeApiFetch<{ user: AuthUser }>('/api/auth/me', {
        headers: { Authorization: `Bearer ${savedToken}` },
      })
        .then((res) => {
          if (res.success && res.data?.user) {
            setCurrentUser(res.data.user)
            localStorage.setItem('mana_user', JSON.stringify(res.data.user))
          } else if (res.status === 401) {
            // Token expired or invalid
            localStorage.removeItem('mana_auth_token')
            localStorage.removeItem('mana_user')
            setAuthToken(null)
            setCurrentUser(null)
          }
        })
        .catch(() => {
          // offline or error, keep cached user
        })
    }
  }, [])

  // Load chat sessions when auth changes
  useEffect(() => {
    fetchSessions()
  }, [authToken, fetchSessions])

  // Load config on mount
  useEffect(() => {
    safeApiFetch<AppConfig>('/api/config')
      .then((res) => {
        if (res.success && res.data) {
          setConfig((prev) => ({ ...prev, ...res.data }))
        }
      })
      .catch((err) => console.warn('Could not load config:', err))
  }, [])

  // Auto-collapse sidebar on smaller screens
  useEffect(() => {
    if (window.innerWidth < 820) {
      setIsSidebarOpen(false)
    }
  }, [])

  // Auto-scroll to bottom of messages (auto behavior during streaming prevents animation thrashing)
  useEffect(() => {
    if (!messages.length) return
    if (!shouldAutoScrollRef.current) return
    const isStreaming = messages[messages.length - 1]?.isStreaming
    messagesEndRef.current?.scrollIntoView({
      behavior: isStreaming ? 'auto' : 'smooth',
      block: 'end',
    })
  }, [messages])

  const handleUpdateConfig = async (partial: Partial<AppConfig>) => {
    try {
      const res = await safeApiFetch<{ config: AppConfig }>('/api/config', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(partial),
      })
      if (res.success && res.data?.config) {
        setConfig(res.data.config)
      }
    } catch (err) {
      console.error('Failed to update config:', err)
    }
  }

  const handleToggleVoiceMode = () => {
    const currentVoice = config.voiceSettings || DEFAULT_VOICE_SETTINGS
    const updated = {
      ...currentVoice,
      voiceMode: !currentVoice.voiceMode,
    }
    handleUpdateConfig({ voiceSettings: updated })
  }

  // Voice: Speak message aloud
  const handleSpeakMessage = useCallback((messageId: string, content: string) => {
    // If currently speaking this specific message, toggle it off
    if (speakingMessageIdRef.current === messageId && isSpeakingRef.current) {
      voiceManager.stopSpeaking()
      setIsSpeaking(false)
      setSpeakingMessageId(null)
      return
    }

    // Stop listening before speaking to prevent echo / feedback loop
    if (isListeningRef.current) {
      voiceManager.stopListening()
      setIsListening(false)
    }

    const currentVoiceSettings = configRef.current.voiceSettings || DEFAULT_VOICE_SETTINGS
    setIsSpeaking(true)
    setSpeakingMessageId(messageId)

    voiceManager.speak(content, currentVoiceSettings, {
      onStart: () => {
        setIsSpeaking(true)
        setSpeakingMessageId(messageId)
      },
      onEnd: () => {
        setIsSpeaking(false)
        setSpeakingMessageId(null)
      },
      onError: (err) => {
        console.warn('Speech synthesis playback error:', err)
        setIsSpeaking(false)
        setSpeakingMessageId(null)
      },
    })
  }, [])

  // Voice: Stop speech playback
  const handleStopSpeaking = useCallback(() => {
    voiceManager.stopSpeaking()
    setIsSpeaking(false)
    setSpeakingMessageId(null)
  }, [])

  // Voice: Toggle Microphone listening
  const handleToggleVoice = useCallback(() => {
    if (isListeningRef.current) {
      voiceManager.stopListening()
      setIsListening(false)
      return
    }

    // Clear previous error
    setVoiceError(null)

    // Stop assistant speech immediately if it's currently speaking (interruption)
    if (isSpeakingRef.current) {
      voiceManager.stopSpeaking()
      setIsSpeaking(false)
      setSpeakingMessageId(null)
    }

    const lang = configRef.current.voiceSettings?.language || 'en-US'

    const started = voiceManager.startListening({
      lang,
      onInterim: (interimText) => {
        setInput(interimText)
      },
      onFinal: (finalText) => {
        setInput(finalText)
      },
      onError: (errMsg) => {
        setVoiceError(errMsg)
        setIsListening(false)
      },
      onEnd: () => {
        setIsListening(false)
      },
    })

    if (started) {
      setIsListening(true)
    }
  }, [])

  const handleAuthSuccess = (user: AuthUser, token: string) => {
    setCurrentUser(user)
    setAuthToken(token)
    // Reload sessions for the newly logged in user
    setTimeout(() => {
      fetchSessions()
    }, 100)
  }

  const handleLogout = () => {
    clearStagedAttachments()
    localStorage.removeItem('mana_auth_token')
    localStorage.removeItem('mana_user')
    localStorage.removeItem('mana_cached_sessions')
    localStorage.removeItem('mana_active_session_id')
    setAuthToken(null)
    setCurrentUser(null)
    setCurrentSessionId(null)
    currentSessionIdRef.current = null
    setMessages([])
    handleStopSpeaking()
    voiceManager.stopListening()
    setIsListening(false)
    setTimeout(() => {
      fetchSessions()
    }, 100)
  }

  // Select and load a chat session from sidebar
  const handleSelectSession = async (sessionId: string) => {
    if (isGenerating && abortControllerRef.current) {
      abortControllerRef.current.abort()
      setIsGenerating(false)
      isGeneratingRef.current = false
    }

    handleStopSpeaking()
    voiceManager.stopListening()
    setIsListening(false)
    clearStagedAttachments()

    try {
      localStorage.setItem('mana_active_session_id', sessionId)
      const res = await safeApiFetch<{ session: { messages: Message[] } }>(`/api/chats/${sessionId}`, {
        headers: getAuthHeaders(),
      })
      if (res.success && res.data?.session) {
        const filesResult = await safeApiFetch<{ files: ConversationFileAttachment[] }>(
          `/api/chats/${sessionId}/files`,
          { headers: getAuthHeaders() }
        )
        setCurrentSessionId(sessionId)
        currentSessionIdRef.current = sessionId
        setMessages(res.data.session.messages || [])
        if (filesResult.success && Array.isArray(filesResult.data?.files)) {
          setStagedAttachments(filesResult.data.files.map((file) => ({
            ...file,
            status: 'complete',
            progress: 100,
            sessionId,
          })))
        }
        if (window.innerWidth < 820) {
          setIsSidebarOpen(false)
        }
      }
    } catch (err) {
      console.error('Failed to load session:', err)
    }
  }

  const handleRenameSession = async (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) return
    const title = window.prompt('Rename conversation', session.title)?.trim()
    if (!title || title === session.title) return

    try {
      const result = await safeApiFetch<{ session: ChatSessionSummary }>(`/api/chats/${sessionId}/title`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ title }),
      })
      if (!result.success) throw new Error(result.error || 'Could not rename this conversation.')
      const updated = sessions.map((item) =>
        item.id === sessionId ? { ...item, title, titleManuallyRenamed: true } : item
      )
      setSessions(updated)
      try {
        localStorage.setItem('mana_cached_sessions', JSON.stringify(updated))
      } catch {}
    } catch (err) {
      console.error('Failed to rename conversation:', err)
    }
  }

  // Auto-restore active session from localStorage on load
  useEffect(() => {
    const savedActiveId = localStorage.getItem('mana_active_session_id')
    if (savedActiveId && !currentSessionId && sessions.length > 0) {
      if (sessions.some((s) => s.id === savedActiveId)) {
        handleSelectSession(savedActiveId)
      }
    }
  }, [sessions])

  // Delete a chat session
  const handleDeleteSession = async (sessionId: string) => {
    try {
      await safeApiFetch(`/api/chats/${sessionId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })

      setSessions((prev) => {
        const updated = prev.filter((s) => s.id !== sessionId)
        try {
          localStorage.setItem('mana_cached_sessions', JSON.stringify(updated))
        } catch {}
        return updated
      })

      if (currentSessionId === sessionId) {
        clearStagedAttachments()
        localStorage.removeItem('mana_active_session_id')
        setCurrentSessionId(null)
        currentSessionIdRef.current = null
        setMessages([])
        handleStopSpeaking()
      }
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  // Clear current active conversation
  const handleClearChat = () => {
    if (isGenerating && abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    handleStopSpeaking()
    voiceManager.stopListening()
    setIsListening(false)
    clearStagedAttachments()
    setMessages([])
    setCurrentSessionId(null)
    currentSessionIdRef.current = null
    localStorage.removeItem('mana_active_session_id')
    setIsGenerating(false)
    isGeneratingRef.current = false
  }

  // Start a fresh new chat
  const handleNewChat = () => {
    handleClearChat()
    setInput('')
    if (window.innerWidth < 820) {
      setIsSidebarOpen(false)
    }
  }

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    handleStopSpeaking()
    isGeneratingRef.current = false
    setIsGenerating(false)
    setMessages((prev) => {
      const copy = [...prev]
      if (copy.length > 0 && copy[copy.length - 1].role === 'assistant') {
        copy[copy.length - 1].isStreaming = false
        copy[copy.length - 1].isSearching = false
        if (copy[copy.length - 1].isGeneratingMedia) {
          copy[copy.length - 1].isGeneratingMedia = false
          copy[copy.length - 1].mediaError = 'Generation cancelled.'
        }
      }
      return copy
    })
  }

  const handleSetSearchMode = (searchMode: SearchMode) => {
    handleUpdateConfig({ searchMode })
  }

  const handleFeedback = async (
    messageId: string,
    rating: 'thumbs_up' | 'thumbs_down',
    comment?: string
  ) => {
    const targetMsg = messages.find((m) => m.id === messageId)
    const targetIdx = messages.findIndex((m) => m.id === messageId)
    const userPrompt = targetIdx > 0 ? messages[targetIdx - 1]?.content : ''

    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, feedback: rating } : m))
    )

    try {
      await safeApiFetch('/api/feedback', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          messageId,
          prompt: userPrompt,
          response: targetMsg?.content || '',
          rating,
          comment,
        }),
      })
    } catch (err) {
      console.error('Error saving feedback:', err)
    }
  }

  // Save conversation messages to backend session
  const saveSessionMessages = async (sessionId: string, msgsToSave: Message[]) => {
    try {
      await safeApiFetch(`/api/chats/${sessionId}/messages`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          messages: msgsToSave.map(({
            isStreaming: _isStreaming,
            isSearching: _isSearching,
            isGeneratingMedia: _isGeneratingMedia,
            mediaProgress: _mediaProgress,
            ...message
          }) => message),
        }),
      })
      // Refresh sidebar sessions list
      fetchSessions()
    } catch (err) {
      console.warn('Error saving session messages:', err)
    }
  }

  const handleGenerateImage = async (
    customPrompt?: string,
    customRatio?: '1:1' | '16:9' | '9:16',
    customQuality?: 'standard' | 'hd'
  ) => {
    const promptToSend = (customPrompt || input).trim()
    if (!promptToSend || isGeneratingRef.current) return
    isGeneratingRef.current = true
    setIsGenerating(true)

    setInput('')
    if (window.innerWidth < 820) {
      setIsSidebarOpen(false)
    }

    let activeSessionId = currentSessionIdRef.current
    if (!activeSessionId) {
      activeSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`
      setCurrentSessionId(activeSessionId)
      currentSessionIdRef.current = activeSessionId
    }

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: promptToSend,
      timestamp: Date.now(),
      mode: 'image',
    }

    const assistantId = `assistant-${Date.now()}`
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      mode: 'image',
      isGeneratingMedia: true,
      mediaProgress: { stage: 'Preparing prompt' },
    }

    const nextMessages = [...messages, userMessage, assistantMessage]
    shouldAutoScrollRef.current = true
    setMessages(nextMessages)

    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const response = await fetch('/api/generate/image/stream', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          prompt: promptToSend,
          aspectRatio: customRatio || imageAspectRatio,
          quality: customQuality || imageQuality,
        }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        let errorMessage = `Image generation failed (HTTP ${response.status}).`
        try {
          const error = await response.json()
          if (typeof error.error === 'string') errorMessage = error.error
        } catch {}
        throw new Error(errorMessage)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let generatedImage: GeneratedImageMetadata | undefined
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        for (const eventBlock of events) {
          let eventName = 'message'
          let eventData = ''
          for (const line of eventBlock.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim()
            else if (line.startsWith('data: ')) eventData += line.slice(6)
          }
          if (!eventData) continue
          const payload = JSON.parse(eventData)
          if (eventName === 'stage' || eventName === 'progress') {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      mediaProgress: {
                        stage: payload.stage || 'Working',
                        ...(typeof payload.progress === 'number' ? { progress: payload.progress } : {}),
                      },
                    }
                  : message
              )
            )
          } else if (eventName === 'done') {
            generatedImage = payload.image
          } else if (eventName === 'error') {
            throw new Error(payload.message || 'Image generation failed.')
          }
        }
      }

      if (!generatedImage) throw new Error('Image generation ended without returning an image.')
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                isGeneratingMedia: false,
                mediaProgress: undefined,
                image: generatedImage,
              }
            : m
        )
      )
      saveSessionMessages(activeSessionId, [
        ...nextMessages.filter((m) => m.id !== assistantId),
        { ...assistantMessage, isGeneratingMedia: false, mediaProgress: undefined, image: generatedImage },
      ])
    } catch (err: any) {
      console.error('[App] Image generation error:', err)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                isGeneratingMedia: false,
                mediaProgress: undefined,
                mediaError: err.name === 'AbortError' ? 'Generation cancelled.' : err.message || 'Image generation failed.',
              }
            : m
        )
      )
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
      isGeneratingRef.current = false
      setIsGenerating(false)
    }
  }

  const handleGenerateVideo = async (
    customPrompt?: string,
    customRatio?: '16:9' | '9:16' | '1:1',
    customDuration?: number
  ) => {
    const promptToSend = (customPrompt || input).trim()
    if (!promptToSend || isGeneratingRef.current) return
    isGeneratingRef.current = true
    setIsGenerating(true)

    setInput('')
    if (window.innerWidth < 820) {
      setIsSidebarOpen(false)
    }

    let activeSessionId = currentSessionIdRef.current
    if (!activeSessionId) {
      activeSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`
      setCurrentSessionId(activeSessionId)
      currentSessionIdRef.current = activeSessionId
    }

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: promptToSend,
      timestamp: Date.now(),
      mode: 'video',
    }

    const assistantId = `assistant-${Date.now()}`
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      mode: 'video',
      isGeneratingMedia: true,
    }

    const nextMessages = [...messages, userMessage, assistantMessage]
    shouldAutoScrollRef.current = true
    setMessages(nextMessages)

    try {
      const res = await safeApiFetch<{ job: VideoJobMetadata }>('/api/generate/video', {
        method: 'POST',
        body: JSON.stringify({
          prompt: promptToSend,
          aspectRatio: customRatio || videoAspectRatio,
          duration: customDuration || videoDuration,
        }),
      })

      if (!res.success || !res.data?.job) {
        throw new Error(res.error || 'Video generation job failed.')
      }

      const initialJob = res.data.job
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                video: initialJob,
                isGeneratingMedia: initialJob.status === 'queued' || initialJob.status === 'processing',
              }
            : m
        )
      )

      if (initialJob.status === 'completed' || initialJob.status === 'failed') {
        saveSessionMessages(activeSessionId, [
          ...nextMessages.filter((m) => m.id !== assistantId),
          { ...assistantMessage, isGeneratingMedia: false, video: initialJob },
        ])
        isGeneratingRef.current = false
        setIsGenerating(false)
        return
      }

      // Poll video job status every 2.5 seconds
      const pollInterval = setInterval(async () => {
        try {
          const pollRes = await safeApiFetch<{ job: VideoJobMetadata }>(`/api/generate/video/status/${initialJob.jobId}`)
          if (pollRes.success && pollRes.data?.job) {
            const currentJob = pollRes.data.job
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      video: currentJob,
                      isGeneratingMedia: currentJob.status === 'queued' || currentJob.status === 'processing',
                    }
                  : m
              )
            )

            if (currentJob.status === 'completed' || currentJob.status === 'failed') {
              clearInterval(pollInterval)
              saveSessionMessages(activeSessionId, [
                ...nextMessages.filter((m) => m.id !== assistantId),
                { ...assistantMessage, isGeneratingMedia: false, video: currentJob },
              ])
              isGeneratingRef.current = false
              setIsGenerating(false)
            }
          }
        } catch (pollErr) {
          console.warn('Error polling video job:', pollErr)
        }
      }, 2500)
    } catch (err: any) {
      console.error('[App] Video generation error:', err)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                isGeneratingMedia: false,
                mediaError: err.message || 'Video generation failed.',
              }
            : m
        )
      )
      isGeneratingRef.current = false
      setIsGenerating(false)
    }
  }

  const handleSendPrompt = (customPrompt?: string) => {
    if (chatMode === 'image') {
      handleGenerateImage(customPrompt)
    } else if (chatMode === 'video') {
      handleGenerateVideo(customPrompt)
    } else {
      handleSendMessage(customPrompt)
    }
  }

  const handleSendMessage = async (customPrompt?: string) => {
    const promptToSend = (customPrompt || input).trim()
    if (!promptToSend || isGeneratingRef.current) return
    if (stagedAttachments.some((attachment) => attachment.status !== 'complete')) return
    isGeneratingRef.current = true

    // Immediately stop any speech playback or recognition when new query is submitted
    if (isSpeakingRef.current) {
      voiceManager.stopSpeaking()
      setIsSpeaking(false)
      setSpeakingMessageId(null)
    }
    if (isListeningRef.current) {
      voiceManager.stopListening()
      setIsListening(false)
    }

    setInput('')
    if (window.innerWidth < 820) {
      setIsSidebarOpen(false)
    }

    // Ensure session exists or create one
    let activeSessionId = currentSessionIdRef.current
    if (!activeSessionId) {
      activeSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`
      setCurrentSessionId(activeSessionId)
      currentSessionIdRef.current = activeSessionId
    }

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: promptToSend,
      timestamp: Date.now(),
      attachments: stagedAttachments
        .filter((attachment) => attachment.status === 'complete')
        .map(({ id, name, mimeType, sizeBytes, uploadedAt, extractionStatus, extractionNote, pageCount, worksheets, chunkCount }) => ({
          id,
          name,
          mimeType,
          sizeBytes,
          uploadedAt: uploadedAt || new Date().toISOString(),
          extractionStatus: extractionStatus || 'complete',
          extractionNote,
          pageCount,
          worksheets,
          chunkCount: chunkCount || 0,
        })),
    }
    const sentAttachmentIds = new Set((userMessage.attachments || []).map((attachment) => attachment.id))

    const assistantId = `assistant-${Date.now()}`
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      isSearching: false,
    }

    const nextMessages = [...messages, userMessage, assistantMessage]
    shouldAutoScrollRef.current = true
    setMessages(nextMessages)
    setIsGenerating(true)

    // Context window: send last 16 turns preserving full locality names and context
    const history = messages.slice(-16).map((m) => ({
      role: m.role,
      content: m.content.length > 2500 ? m.content.slice(0, 2500) + '...' : m.content,
    }))

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const streamEndpoint =
        typeof window !== 'undefined' && window.location.hostname !== 'localhost'
          ? '/.netlify/functions/chat-stream'
          : '/api/chat/stream'

      const response = await fetch(streamEndpoint, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          prompt: promptToSend,
          sessionId: activeSessionId,
          history,
          searchMode: config.searchMode,
          reasoningMode: config.reasoningMode,
          aiProvider: config.aiProvider || 'ollama',
          modelName: config.modelName || config.ollamaModel || 'qwen2.5:3b',
          ollamaBaseUrl: config.ollamaBaseUrl,
          ollamaModel: config.ollamaModel,
          // Never send shared server keys from the browser; only pass client BYOK key if explicitly configured
          ...(config.geminiApiKey && config.geminiApiKey.trim().length > 10 && !config.geminiApiKey.includes('••') && !config.geminiApiKey.includes('**')
            ? { geminiApiKey: config.geminiApiKey.trim() }
            : {}),
          ...(config.openaiApiKey && config.openaiApiKey.trim().length > 10 && !config.openaiApiKey.includes('••') && !config.openaiApiKey.includes('**')
            ? { openaiApiKey: config.openaiApiKey.trim() }
            : {}),
          ...(config.groqApiKey && config.groqApiKey.trim().length > 10 && !config.groqApiKey.includes('••') && !config.groqApiKey.includes('**')
            ? { groqApiKey: config.groqApiKey.trim() }
            : {}),
        }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        let errMessage = `Server error (HTTP ${response.status})`
        try {
          const errData = await response.json()
          if (errData.error) {
            errMessage = typeof errData.error === 'string' ? errData.error : errData.error.message || errMessage
          }
        } catch {}
        throw new Error(errMessage)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finalContent = ''
      let finalEvidence = undefined
      let finalImageSearchEvidence = undefined

      // Ultra-fast batched state updater for 60fps streaming rendering
      const currentAssistantState: Partial<Message> = {
        content: '',
        isStreaming: true,
        isSearching: false,
      }

      let rafId: number | null = null
      let isUpdateScheduled = false

      const flushAssistantState = (isFinal = false) => {
        if (rafId) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        isUpdateScheduled = false

        setMessages((prev) => {
          const targetIdx = prev.findIndex((m) => m.id === assistantId)
          if (targetIdx === -1) return prev
          const target = prev[targetIdx]

          if (
            !isFinal &&
            target.content === currentAssistantState.content &&
            target.isStreaming === currentAssistantState.isStreaming &&
            target.isSearching === currentAssistantState.isSearching &&
            target.searchStatus === currentAssistantState.searchStatus
          ) {
            return prev
          }

          const copy = [...prev]
          copy[targetIdx] = {
            ...target,
            ...currentAssistantState,
          }
          return copy
        })
      }

      const scheduleBatchUpdate = () => {
        if (isUpdateScheduled) return
        isUpdateScheduled = true
        rafId = requestAnimationFrame(() => {
          flushAssistantState(false)
        })
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''

        let hasNewTokens = false

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue

          const lines = eventBlock.split('\n')
          let eventType = 'message'
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6)
            }
          }

          if (!eventData) continue

          try {
            const parsed = JSON.parse(eventData)

            switch (eventType) {
              case 'search_start':
                currentAssistantState.isSearching = true
                currentAssistantState.isSearchPerformed = true
                currentAssistantState.intent = parsed
                flushAssistantState(false)
                break

              case 'search_status':
                currentAssistantState.searchStatus = parsed.status
                flushAssistantState(false)
                break

              case 'provider_fallback':
                currentAssistantState.isSearching = true
                currentAssistantState.searchStatus = parsed.message
                flushAssistantState(false)
                break

              case 'search_results':
                currentAssistantState.searchEvidence = parsed
                finalEvidence = parsed
                currentAssistantState.isSearching = false
                flushAssistantState(false)
                break

              case 'image_search_results':
                currentAssistantState.imageSearchEvidence = parsed
                finalImageSearchEvidence = parsed
                currentAssistantState.isSearching = false
                flushAssistantState(false)
                break

              case 'token':
                currentAssistantState.content = (currentAssistantState.content || '') + parsed.token
                finalContent = currentAssistantState.content
                hasNewTokens = true
                break

              case 'done':
                currentAssistantState.isStreaming = false
                currentAssistantState.isSearching = false
                currentAssistantState.reasoningMode = parsed.reasoningMode
                if (parsed.timings) {
                  currentAssistantState.timings = parsed.timings
                }
                if (parsed.documentsUsed) {
                  currentAssistantState.documentsUsed = parsed.documentsUsed
                }
                if (parsed.searchEvidence) {
                  currentAssistantState.searchEvidence = parsed.searchEvidence
                  finalEvidence = parsed.searchEvidence
                }
                if (parsed.imageSearchEvidence) {
                  currentAssistantState.imageSearchEvidence = parsed.imageSearchEvidence
                  finalImageSearchEvidence = parsed.imageSearchEvidence
                }
                flushAssistantState(true)
                break

              case 'error':
                currentAssistantState.isStreaming = false
                currentAssistantState.isSearching = false
                currentAssistantState.content =
                  (currentAssistantState.content ? currentAssistantState.content + '\n\n' : '') +
                  `⚠️ **Error**: ${parsed.message}`
                finalContent = currentAssistantState.content
                flushAssistantState(true)
                break
            }
          } catch (jsonErr) {
            console.error('Error parsing SSE JSON:', jsonErr)
          }
        }

        if (hasNewTokens) {
          scheduleBatchUpdate()
        }
      }

      // Final flush guaranteeing all state is committed immediately
      flushAssistantState(true)

      // Persist finished conversation to backend session
      const completedAssistantMsg: Message = {
        ...assistantMessage,
        content: finalContent,
        searchEvidence: finalEvidence,
        imageSearchEvidence: finalImageSearchEvidence,
        reasoningMode: configRef.current.reasoningMode,
        isStreaming: false,
        isSearching: false,
      }
      const allCurrentMsgs = [...messages, userMessage, completedAssistantMsg]
      saveSessionMessages(activeSessionId, allCurrentMsgs)
      setStagedAttachments((previous) => {
        const remaining = previous.filter((attachment) => !sentAttachmentIds.has(attachment.id))
        previous
          .filter((attachment) => sentAttachmentIds.has(attachment.id))
          .forEach((attachment) => {
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
          })
        return remaining
      })

      // Auto-speak completed answer if Voice Mode is active
      if (configRef.current.voiceSettings?.voiceMode && finalContent.trim()) {
        handleSpeakMessage(assistantId, finalContent)
      }

    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Chat error:', err)
        setMessages((prev) => {
          const copy = [...prev]
          const target = copy.find((m) => m.id === assistantId)
          if (target) {
            target.isStreaming = false
            target.isSearching = false
            target.content =
              (target.content ? target.content + '\n\n' : '') +
              `⚠️ **Error**: ${err.message || 'Unable to connect to Mana AI backend.'}`
          }
          return copy
        })
      }
    } finally {
      isGeneratingRef.current = false
      setIsGenerating(false)
      abortControllerRef.current = null
      setMessages((prev) => {
        const copy = [...prev]
        const target = copy.find((m) => m.id === assistantId)
        if (target) {
          target.isStreaming = false
          target.isSearching = false
        }
        return copy
      })
    }
  }

  const handleRegenerateChat = (assistantMsgId: string) => {
    if (isGenerating) return
    const idx = messages.findIndex((m) => m.id === assistantMsgId)
    if (idx > 0) {
      const userPrompt = messages[idx - 1]?.content
      if (userPrompt) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId))
        handleSendMessage(userPrompt)
      }
    }
  }

  const hasMessages = messages.length > 0

  return (
    <div className="chatgpt-layout">
      {/* Sidebar with Chat History & Search Filter */}
      <Sidebar
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        onNewChat={handleNewChat}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenMemory={() => setIsMemoryOpen(true)}
        onOpenAuth={() => setIsAuthOpen(true)}
        onLogout={handleLogout}
        onSelectPrompt={(p) => handleSendPrompt(p)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        currentUser={currentUser}
      />

      {/* Main Chat Workspace */}
      <div className="chatgpt-main">
        {/* Top Header */}
        <Header
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          onNewChat={handleNewChat}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenMemory={() => setIsMemoryOpen(true)}
          onOpenAuth={() => setIsAuthOpen(true)}
          currentUser={currentUser}
          isVoiceMode={!!config.voiceSettings?.voiceMode}
          onToggleVoiceMode={handleToggleVoiceMode}
        />

        {/* Content Area */}
        <div
          className="chatgpt-conversation-area"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault()
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return
            event.preventDefault()
            void handleUploadFiles(Array.from(event.dataTransfer.files))
          }}
          onScroll={(event) => {
            const element = event.currentTarget
            shouldAutoScrollRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 120
          }}
        >
          {!hasMessages ? (
            <div className="chatgpt-empty-state">
              <div className="mana-empty-logo">
                <ManaLogo size={36} />
              </div>
              <h1 className="empty-state-title">
                {currentUser?.name ? `Hey, ${currentUser.name}!` : "What's on your mind?"}
              </h1>
              <p className="empty-state-subtitle">
                Your AI. Your World.
              </p>
            </div>
          ) : (
            <div className="chatgpt-message-list">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  onFeedback={handleFeedback}
                  isSpeakingMessage={speakingMessageId === message.id && isSpeaking}
                  onSpeakMessage={handleSpeakMessage}
                  onStopSpeaking={handleStopSpeaking}
                  onPreviewImage={(img) => setLightboxImage(img)}
                  onRegenerateImage={(prompt, ratio, qual) =>
                    handleGenerateImage(prompt, ratio as any, qual as any)
                  }
                  onRegenerateVideo={(prompt, ratio, dur) =>
                    handleGenerateVideo(prompt, ratio as any, dur)
                  }
                  onRegenerateChat={handleRegenerateChat}
                  onOpenSettings={() => setIsSettingsOpen(true)}
                  allowExternalImageLoads={config.searchMode !== 'never'}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Bottom Floating Input Bar with Mode Switcher & Voice Controls */}
        <ChatInput
          input={input}
          onChange={setInput}
          onSend={() => handleSendPrompt()}
          onStop={handleStopGeneration}
          isGenerating={isGenerating}
          searchMode={config.searchMode}
          onSetSearchMode={handleSetSearchMode}
          isListening={isListening}
          onToggleVoice={handleToggleVoice}
          voiceError={voiceError}
          onClearVoiceError={() => setVoiceError(null)}
          isVoiceSupported={isSpeechRecognitionSupported()}
          mode={chatMode}
          onSelectMode={setChatMode}
          imageAspectRatio={imageAspectRatio}
          onSelectImageAspectRatio={setImageAspectRatio}
          imageQuality={imageQuality}
          onSelectImageQuality={setImageQuality}
          videoAspectRatio={videoAspectRatio}
          onSelectVideoAspectRatio={setVideoAspectRatio}
          videoDuration={videoDuration}
          onSelectVideoDuration={setVideoDuration}
          attachments={stagedAttachments}
          onUploadFiles={(files) => void handleUploadFiles(files)}
          onRemoveAttachment={handleRemoveAttachment}
        />

        {/* Settings Modal */}
        <SettingsModal
          config={config}
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          onSave={handleUpdateConfig}
          onOpenMemory={() => {
            setIsSettingsOpen(false)
            setIsMemoryOpen(true)
          }}
          onClearAllChats={async () => {
            for (const s of sessions) {
              await safeApiFetch(`/api/chats/${s.id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
              })
            }
            setSessions([])
            try {
              localStorage.removeItem('mana_cached_sessions')
            } catch {}
            handleClearChat()
          }}
          onExportChats={() => {
            const exportData = {
              exportedAt: new Date().toISOString(),
              version: '1.2.0',
              sessions,
              currentMessages: messages,
              user: currentUser?.email || 'guest',
            }
            const blob = new Blob([JSON.stringify(exportData, null, 2)], {
              type: 'application/json',
            })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `mana-ai-chat-export-${new Date().toISOString().slice(0, 10)}.json`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
          }}
        />

        {/* Memory Modal */}
        <MemoryModal
          isOpen={isMemoryOpen}
          onClose={() => setIsMemoryOpen(false)}
        />

        {/* Auth Modal (Login / Sign Up) */}
        <AuthModal
          isOpen={isAuthOpen}
          onClose={() => setIsAuthOpen(false)}
          onAuthSuccess={handleAuthSuccess}
        />

        {/* Image Lightbox Modal */}
        <ImageLightboxModal
          image={lightboxImage}
          onClose={() => setLightboxImage(null)}
        />
      </div>
    </div>
  )
}

export default App
