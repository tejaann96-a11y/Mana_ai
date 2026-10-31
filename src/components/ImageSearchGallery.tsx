import React, { useEffect, useState } from 'react'
import { ExternalLink, ImageOff, X, ZoomIn } from 'lucide-react'
import { ImageSearchEvidence, ImageSearchResult } from '../types/chat'

interface ImageSearchGalleryProps {
  evidence: ImageSearchEvidence
  allowExternalLoads: boolean
}

export const ImageSearchGallery: React.FC<ImageSearchGalleryProps> = ({ evidence, allowExternalLoads }) => {
  const [preview, setPreview] = useState<ImageSearchResult | null>(null)
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set())
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    if (!preview) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [preview])

  useEffect(() => {
    setPreviewFailed(false)
  }, [preview?.id])

  useEffect(() => {
    setFailedIds(new Set())
    setPreview(null)
  }, [evidence])

  return (
    <section className="image-search-gallery" aria-label={`Image search results for ${evidence.query}`}>
      <div className="image-search-heading">Web image search · not AI-generated · {evidence.provider}</div>
      {!allowExternalLoads ? (
        <p className="image-search-notice">Image previews are paused because web search is off.</p>
      ) : evidence.results.length > 0 ? (
        <div className="image-search-grid">
          {evidence.results.map((result) => (
            <article className="image-search-card" key={result.id}>
              <button
                type="button"
                className="image-search-preview-button"
                onClick={() => setPreview(result)}
                disabled={failedIds.has(result.id)}
                aria-label={`Open image preview: ${result.title}`}
              >
                {allowExternalLoads && !failedIds.has(result.id) ? (
                  <img
                    className="image-search-thumbnail"
                    src={result.thumbnailUrl}
                    alt={result.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => setFailedIds((previous) => new Set(previous).add(result.id))}
                  />
                ) : (
                  <span className="image-search-unavailable">
                    <ImageOff size={24} />
                    <span>Preview unavailable</span>
                  </span>
                )}
                {!failedIds.has(result.id) && <span className="image-search-zoom"><ZoomIn size={16} /></span>}
              </button>
              <div className="image-search-card-details">
                <span className="image-search-title" title={result.title}>{result.title}</span>
                <a
                  className="image-search-source"
                  href={result.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  title={`Open source: ${result.sourceDomain}`}
                >
                  {result.sourceDomain}
                  <ExternalLink size={12} />
                </a>
                <a
                  className="image-search-original"
                  href={result.imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Open original image
                </a>
                {result.license && <span className="image-search-license">Provider label: {result.license}</span>}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="image-search-notice">{evidence.errorMessage || 'No usable image results were found.'}</p>
      )}
      <p className="image-search-attribution">
        Images remain hosted by their source websites. Check each source’s license and usage terms before reuse.
      </p>

      {preview && allowExternalLoads && (
        <div
          className="image-search-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Image preview: ${preview.title}`}
          onClick={() => setPreview(null)}
        >
          <div className="image-search-lightbox-content" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="image-search-lightbox-close"
              aria-label="Close image preview"
              onClick={() => setPreview(null)}
            >
              <X size={20} />
            </button>
            {previewFailed ? (
              <div className="image-search-preview-error"><ImageOff size={28} /> Original image is unavailable.</div>
            ) : (
              <img
                className="image-search-large-image"
                src={preview.imageUrl}
                alt={preview.title}
                referrerPolicy="no-referrer"
                onError={() => setPreviewFailed(true)}
              />
            )}
            <div className="image-search-preview-footer">
              <span>{preview.title} · {preview.sourceDomain}</span>
              <a href={preview.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                Visit source <ExternalLink size={13} />
              </a>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
