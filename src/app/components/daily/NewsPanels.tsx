import { Minus, Play } from 'lucide-react';
import { topicLabel } from './newsTopics';
import type { NewsItem } from './types';

// A real story picture is at least this big. Anything smaller is a tracking
// beacon, an icon or a stray logo — not something to show as a story graphic.
const MIN_IMAGE_WIDTH = 200;
const MIN_IMAGE_HEIGHT = 110;

interface ItemProps {
  item: NewsItem;
  onOpen: (url: string) => void;
  // Called when the picture fails to load or is too small to be a real one;
  // the dashboard then drops the story and brings in the next one.
  onBroken: (image: string) => void;
}

function StoryImage({ item, onBroken }: { item: NewsItem; onBroken: ItemProps['onBroken'] }) {
  return (
    <img
      src={item.image}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => onBroken(item.image)}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalWidth < MIN_IMAGE_WIDTH || naturalHeight < MIN_IMAGE_HEIGHT) onBroken(item.image);
      }}
    />
  );
}

function Source({ item }: { item: NewsItem }) {
  return (
    <span className="dd-source">
      {item.source}
      {item.category && item.category !== item.source && (
        <>
          <i>·</i>
          {item.category}
        </>
      )}
    </span>
  );
}

// ---- Middle column ------------------------------------------------------------

export function TopStory({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-story" onClick={() => onOpen(item.link)}>
      <div className="dd-story-media">
        <StoryImage item={item} onBroken={onBroken} />
      </div>
      <div className="dd-story-body">
        <Source item={item} />
        <h3>{item.title}</h3>
        {item.summary && <p>{item.summary}</p>}
      </div>
    </button>
  );
}

// ---- Right column: one component per story style ---------------------------------

function FeaturedStory({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-feature" onClick={() => onOpen(item.link)}>
      <StoryImage item={item} onBroken={onBroken} />
      <div className="dd-feature-caption">
        <strong>{item.title}</strong>
        <Source item={item} />
      </div>
    </button>
  );
}

function NewsRow({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-news-row" onClick={() => onOpen(item.link)}>
      <div className="dd-news-thumb">
        <StoryImage item={item} onBroken={onBroken} />
      </div>
      <div className="dd-news-text">
        <strong>{item.title}</strong>
        <Source item={item} />
        {item.summary && <p>{item.summary}</p>}
      </div>
    </button>
  );
}

function GridCard({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-grid-card" onClick={() => onOpen(item.link)}>
      <div className="dd-grid-card-media">
        <StoryImage item={item} onBroken={onBroken} />
      </div>
      <strong>{item.title}</strong>
      <Source item={item} />
    </button>
  );
}

function TallStory({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-tall" onClick={() => onOpen(item.link)}>
      <StoryImage item={item} onBroken={onBroken} />
      <div className="dd-feature-caption">
        <strong>{item.title}</strong>
        <Source item={item} />
      </div>
    </button>
  );
}

function CompactStory({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-compact" onClick={() => onOpen(item.link)}>
      <div className="dd-compact-thumb">
        <StoryImage item={item} onBroken={onBroken} />
      </div>
      <div className="dd-compact-text">
        <strong>{item.title}</strong>
        <Source item={item} />
      </div>
    </button>
  );
}

function WideStory({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-wide" onClick={() => onOpen(item.link)}>
      <div className="dd-wide-media">
        <StoryImage item={item} onBroken={onBroken} />
      </div>
      <strong>{item.title}</strong>
      {item.summary && <p>{item.summary}</p>}
      <Source item={item} />
    </button>
  );
}

function TrailerHero({ item, onOpen, onBroken }: ItemProps) {
  return (
    <button type="button" className="dd-trailer-hero" onClick={() => onOpen(item.link)}>
      <StoryImage item={item} onBroken={onBroken} />
      <span className="dd-play" aria-hidden>
        <Play size={17} fill="currentColor" />
      </span>
      <div className="dd-feature-caption">
        <strong>{item.title}</strong>
        <Source item={item} />
      </div>
    </button>
  );
}

export type NewsBlockStyle = 'feature' | 'rows' | 'grid' | 'tall' | 'compact' | 'wide' | 'trailer';

export interface NewsBlockData {
  key: string;
  style: NewsBlockStyle;
  // Which hideable topic the block belongs to (see newsTopics.ts).
  topic: string;
  label: string;
  items: NewsItem[];
}

// The minus in a section's corner. Quiet until you point at it.
export function HideButton({ label, onHide }: { label: string; onHide: () => void }) {
  return (
    <button type="button" className="dd-hide" onClick={onHide} aria-label={`Hide ${label}`} title={`Hide ${label}`}>
      <Minus size={13} />
    </button>
  );
}

interface BlockBodyProps {
  block: NewsBlockData;
  onOpen: (url: string) => void;
  onBroken: (image: string) => void;
  onHide: (topic: string) => void;
}

// The label and the stories of one block, laid out in that block's style.
export function NewsBlockBody({ block, onOpen, onBroken, onHide }: BlockBodyProps) {
  const shared = { onOpen, onBroken };
  return (
    <>
      <div className="dd-block-head">
        <h3 className="dd-label">{block.label}</h3>
        <HideButton label={topicLabel(block.topic)} onHide={() => onHide(block.topic)} />
      </div>
      {block.style === 'feature' && <FeaturedStory item={block.items[0]} {...shared} />}
      {block.style === 'tall' && <TallStory item={block.items[0]} {...shared} />}
      {block.style === 'wide' && <WideStory item={block.items[0]} {...shared} />}
      {block.style === 'trailer' && <TrailerHero item={block.items[0]} {...shared} />}
      {block.style === 'rows' && (
        <div className="dd-news-stack">
          {block.items.map((item) => (
            <NewsRow key={item.link} item={item} {...shared} />
          ))}
        </div>
      )}
      {block.style === 'grid' && (
        <div className="dd-story-grid">
          {block.items.map((item) => (
            <GridCard key={item.link} item={item} {...shared} />
          ))}
        </div>
      )}
      {block.style === 'compact' && (
        <div className="dd-compact-list">
          {block.items.map((item) => (
            <CompactStory key={item.link} item={item} {...shared} />
          ))}
        </div>
      )}
    </>
  );
}
