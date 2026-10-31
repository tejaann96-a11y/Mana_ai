import React, { useRef, useEffect, useState } from 'react'
import {
  ArrowUp,
  Square,
  Globe,
  Plus,
  Mic,
  MicOff,
  AlertCircle,
  X,
  MessageSquare,
  Sparkles,
  Film,
  Upload,
  FileText
} from 'lucide-react'
import { SearchMode, ChatMode, StagedFileAttachment } from '../types/chat'

interface ChatInputProps {
  input: string
  onChange: (val: string) => void
  onSend: () => void
  onStop: () => void
  isGenerating: boolean
  searchMode: SearchMode
  isListening: boolean
  onToggleVoice: () => void
  voiceError: string | null
  onClearVoiceError: () => void
  isVoiceSupported: boolean

  // Mode Selection
  mode: ChatMode
  onSelectMode: (mode: ChatMode) => void
  onSetSearchMode: (mode: SearchMode) => void

  // Image Generation Options
  imageAspectRatio: '1:1' | '16:9' | '9:16'
  onSelectImageAspectRatio: (ratio: '1:1' | '16:9' | '9:16') => void
  imageQuality: 'standard' | 'hd'
  onSelectImageQuality: (quality: 'standard' | 'hd') => void

  // Video Generation Options
  videoAspectRatio: '16:9' | '9:16' | '1:1'
  onSelectVideoAspectRatio: (ratio: '16:9' | '9:16' | '1:1') => void
  videoDuration: number
  onSelectVideoDuration: (duration: number) => void
  attachments: StagedFileAttachment[]
  onUploadFiles: (files: File[]) => void
  onRemoveAttachment: (attachment: StagedFileAttachment) => void
}

export const ChatInput: React.FC<ChatInputProps> = ({
  input,
  onChange,
  onSend,
  onStop,
  isGenerating,
  searchMode,
  isListening,
  onToggleVoice,
  voiceError,
  onClearVoiceError,
  isVoiceSupported,
  mode,
  onSelectMode,
  onSetSearchMode,
  imageAspectRatio,
  onSelectImageAspectRatio,
  imageQuality,
  onSelectImageQuality,
  videoAspectRatio,
  onSelectVideoAspectRatio,
  videoDuration,
  onSelectVideoDuration,
  attachments = [],
  onUploadFiles = () => undefined,
  onRemoveAttachment = () => undefined,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toolsMenuRef = useRef<HTMLDivElement>(null)
  const [isToolsMenuOpen, setIsToolsMenuOpen] = useState(false)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`
    }
  }, [input])

  useEffect(() => {
    if (!isToolsMenuOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!toolsMenuRef.current?.contains(event.target as Node)) setIsToolsMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsToolsMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isToolsMenuOpen])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isGenerating) return
      if (input.trim()) onSend()
    }
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length) {
      event.preventDefault()
      onUploadFiles(files)
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.files.length) return
    event.preventDefault()
    onUploadFiles(Array.from(event.dataTransfer.files))
  }

  const formatFileSize = (size: number) =>
    size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`

  // Dynamic placeholder text based on selected mode
  let placeholderText = 'Ask Mana AI anything...'
  if (isListening) {
    placeholderText = 'Listening to you speak...'
  } else if (mode === 'image') {
    placeholderText = 'Describe the image you want to generate (e.g. A realistic photo of a black sports car in a rainy neon city)...'
  } else if (mode === 'video') {
    placeholderText = 'Describe the video you want to generate (e.g. Create a 10-second cinematic video of a sports car driving through a rainy city at night)...'
  }

  return (
    <div
      className="chatgpt-input-container"
      ref={toolsMenuRef}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="Attached files">
          {attachments.map((attachment) => (
            <div className={`composer-attachment ${attachment.status}`} key={attachment.id}>
              {attachment.previewUrl ? (
                <img className="composer-attachment-preview" src={attachment.previewUrl} alt="" />
              ) : (
                <FileText size={18} />
              )}
              <div className="composer-attachment-details">
                <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                <span className="composer-attachment-meta">
                  {attachment.status === 'uploading'
                    ? attachment.progress >= 100 ? 'Processing locally...' : `Uploading ${attachment.progress}%`
                    : attachment.status === 'failed'
                      ? attachment.error || 'Upload failed'
                        : `${attachment.name.split('.').pop()?.toUpperCase() || 'FILE'} · ${formatFileSize(attachment.sizeBytes)}${attachment.pageCount ? ` · ${attachment.pageCount} pages` : ''}${attachment.worksheets ? ` · ${attachment.worksheets.length} worksheets${attachment.worksheets.some((sheet) => sheet.hidden) ? ' (hidden included)' : ''}` : ''}${attachment.extractionNote ? ` · ${attachment.extractionNote}` : ''}`}
                </span>
                {attachment.status === 'uploading' && (
                  <span className="composer-attachment-progress">
                    <span style={{ width: `${attachment.progress}%` }} />
                  </span>
                )}
              </div>
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => onRemoveAttachment(attachment)}
                aria-label={`Remove ${attachment.name}`}
                title="Remove file"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,.md"
        className="composer-file-input"
        onChange={(event) => {
          if (event.target.files?.length) onUploadFiles(Array.from(event.target.files))
          event.target.value = ''
        }}
      />

      {/* 1. Mode Selector Tabs (Chat / Image / Video) */}
      <div className="mana-mode-switcher-container">
        <div className="mana-mode-pills">
          <button
            type="button"
            className={`mana-mode-tab ${mode === 'chat' ? 'active chat' : ''}`}
            onClick={() => onSelectMode('chat')}
            title="Standard conversational AI chat"
          >
            <MessageSquare size={13} />
            <span>Chat</span>
          </button>

          <button
            type="button"
            className={`mana-mode-tab ${mode === 'image' ? 'active image' : ''}`}
            onClick={() => onSelectMode('image')}
            title="AI Image Generation mode"
          >
            <Sparkles size={13} />
            <span>Image</span>
          </button>

          <button
            type="button"
            className={`mana-mode-tab ${mode === 'video' ? 'active video' : ''}`}
            onClick={() => onSelectMode('video')}
            title="AI Video Generation mode"
          >
            <Film size={13} />
            <span>Video</span>
          </button>
        </div>

      </div>

      {isToolsMenuOpen && (
        <div className="composer-tools-menu" role="dialog" aria-label="Composer tools">
          <section className="composer-tools-section">
            <div className="composer-tools-heading"><Upload size={15} /> Files</div>
            <button
              type="button"
              className="composer-upload-action"
              onClick={() => {
                fileInputRef.current?.click()
                setIsToolsMenuOpen(false)
              }}
            >
              <Upload size={15} />
              <span>Upload files</span>
            </button>
            <div className="composer-tools-help">Up to 5 files per selection, 15 MB each. Files stay on this device.</div>
          </section>

          <section className="composer-tools-section">
            <div className="composer-tools-heading">Generation</div>
            <div className="composer-tools-options">
              <button
                type="button"
                className={`option-chip ${mode === 'image' ? 'active' : ''}`}
                aria-pressed={mode === 'image'}
                onClick={() => {
                  onSelectMode('image')
                  setIsToolsMenuOpen(false)
                }}
              >
                <Sparkles size={13} /> Image generation
              </button>
              <button
                type="button"
                className={`option-chip ${mode === 'video' ? 'active' : ''}`}
                aria-pressed={mode === 'video'}
                onClick={() => {
                  onSelectMode('video')
                  setIsToolsMenuOpen(false)
                }}
              >
                <Film size={13} /> Video generation
              </button>
            </div>
          </section>

          <section className="composer-tools-section">
            <div className="composer-tools-heading"><Globe size={15} /> Web search</div>
            <div className="composer-tools-options">
              {([
                ['auto', 'Auto'],
                ['always', 'On'],
                ['never', 'Off'],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={`option-chip ${searchMode === value ? 'active' : ''}`}
                  aria-pressed={searchMode === value}
                  onClick={() => onSetSearchMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {mode === 'image' && (
            <section className="composer-tools-section">
              <div className="composer-tools-heading"><Sparkles size={15} /> Image options</div>
              <div className="composer-tools-label">Aspect ratio</div>
              <div className="composer-tools-options">
                {([
                  ['1:1', 'Square'],
                  ['16:9', 'Landscape'],
                  ['9:16', 'Portrait'],
                ] as const).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={`option-chip ${imageAspectRatio === value ? 'active' : ''}`}
                    onClick={() => onSelectImageAspectRatio(value)}
                  >
                    {value} {label}
                  </button>
                ))}
              </div>
              <div className="composer-tools-label">Quality</div>
              <div className="composer-tools-options">
                {(['standard', 'hd'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`option-chip ${imageQuality === value ? 'active' : ''}`}
                    onClick={() => onSelectImageQuality(value)}
                  >
                    {value === 'hd' ? 'HD' : 'Standard'}
                  </button>
                ))}
              </div>
            </section>
          )}

          {mode === 'video' && (
            <section className="composer-tools-section">
              <div className="composer-tools-heading"><Film size={15} /> Video options</div>
              <div className="composer-tools-label">Aspect ratio</div>
              <div className="composer-tools-options">
                {(['16:9', '9:16', '1:1'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`option-chip ${videoAspectRatio === value ? 'active' : ''}`}
                    onClick={() => onSelectVideoAspectRatio(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <div className="composer-tools-label">Duration</div>
              <div className="composer-tools-options">
                {([5, 10] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`option-chip ${videoDuration === value ? 'active' : ''}`}
                    onClick={() => onSelectVideoDuration(value)}
                  >
                    {value}s
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Listening Status Indicator Banner */}
      {isListening && (
        <div className="voice-listening-banner">
          <div className="listening-wave-indicator">
            <span className="wave-bar bar-1" />
            <span className="wave-bar bar-2" />
            <span className="wave-bar bar-3" />
            <span className="wave-bar bar-4" />
          </div>
          <span className="listening-text">Listening to your voice... Speak now</span>
          <button
            type="button"
            className="stop-voice-btn"
            onClick={onToggleVoice}
            id="btn-stop-listening-banner"
            title="Stop listening"
          >
            <Square size={10} fill="currentColor" />
            <span>Stop</span>
          </button>
        </div>
      )}

      {/* Voice Error Banner */}
      {voiceError && (
        <div className="voice-error-banner">
          <AlertCircle size={14} style={{ flexShrink: 0 }} />
          <span className="voice-error-text">{voiceError}</span>
          <button
            type="button"
            className="voice-error-close"
            onClick={onClearVoiceError}
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Main Input Capsule */}
      <div className={`chatgpt-input-capsule ${isListening ? 'listening-active' : ''} mode-${mode}`}>
        <button
          type="button"
          className={`composer-tools-toggle ${isToolsMenuOpen ? 'active' : ''}`}
          onClick={() => setIsToolsMenuOpen((open) => !open)}
          aria-expanded={isToolsMenuOpen}
          aria-label="Open composer tools"
          title="Search and generation options"
        >
          <Plus size={19} />
        </button>

        {/* Textarea Input */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          placeholder={placeholderText}
          rows={1}
          className="chatgpt-textarea"
          id="chat-textarea-input"
          autoFocus
        />

        {/* Voice Input Microphone Button */}
        <button
          type="button"
          className={`input-mic-btn ${isListening ? 'listening' : ''}`}
          onClick={onToggleVoice}
          title={
            !isVoiceSupported
              ? 'Speech recognition not supported in this browser'
              : isListening
              ? 'Click to stop listening'
              : 'Click to speak to Mana AI'
          }
          id="btn-voice-input"
        >
          {isListening ? (
            <div className="mic-listening-icon">
              <MicOff size={18} />
              <span className="mic-pulse-ring" />
            </div>
          ) : (
            <Mic size={18} />
          )}
        </button>

        {/* Send / Stop button */}
        {isGenerating ? (
          <button
            type="button"
            className="chatgpt-send-circle stop"
            onClick={onStop}
            title="Stop generating"
            id="btn-stop-stream"
          >
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className={`chatgpt-send-circle ${input.trim() ? 'ready' : ''} ${mode}`}
            onClick={onSend}
            disabled={!input.trim() || attachments.some((attachment) => attachment.status !== 'complete')}
            title={mode === 'image' ? 'Generate Image' : mode === 'video' ? 'Generate Video' : 'Send prompt'}
            id="btn-send-message"
          >
            {mode === 'image' ? (
              <Sparkles size={17} strokeWidth={2.2} />
            ) : mode === 'video' ? (
              <Film size={17} strokeWidth={2.2} />
            ) : (
              <ArrowUp size={18} strokeWidth={2.5} />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
