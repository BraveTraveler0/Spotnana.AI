// The parts of the news the user can hide. One topic can span several blocks
// (Art appears twice in the right column) and several feed categories
// (Politics and World are one topic).
export const TOPICS = [
  { id: 'top', label: 'Top Story' },
  { id: 'local', label: 'Local News' },
  { id: 'world', label: 'Politics & World' },
  { id: 'technology', label: 'Technology' },
  { id: 'trailers', label: 'Movie Trailer' },
  { id: 'art', label: 'Art' },
  { id: 'science', label: 'Science' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'essays', label: 'Aeon Essays' },
  { id: 'morning', label: 'Morning Brief' },
  { id: 'books', label: 'Books' },
  { id: 'film', label: 'Film' },
  { id: 'history', label: 'History & Culture' },
  { id: 'outdoors', label: 'The Outdoors' },
] as const;

export function topicLabel(id: string): string {
  return TOPICS.find((topic) => topic.id === id)?.label ?? id;
}

// Which topic a story belongs to, from the category its feed is filed under.
export const CATEGORY_TOPIC: Record<string, string> = {
  Politics: 'world',
  World: 'world',
  Technology: 'technology',
  Science: 'science',
  Art: 'art',
  Ideas: 'ideas',
  Essays: 'essays',
  'Morning Brief': 'morning',
  Books: 'books',
  Film: 'film',
  History: 'history',
  Culture: 'history',
  Outdoors: 'outdoors',
  Trailers: 'trailers',
};
