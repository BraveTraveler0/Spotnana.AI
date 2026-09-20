import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, MapPin, Search } from 'lucide-react';
import type { GeocodeResult } from './types';
import './city-autocomplete.css';

const DEBOUNCE_MS = 220;
const MIN_CHARS = 2;

export function geocodeLabel(result: GeocodeResult): string {
  return result.label || [result.name, result.admin1, result.country].filter(Boolean).join(', ');
}

interface Props {
  // Called with the place the user picked. May be async; the field clears once
  // it settles, and any error it throws is shown under the field.
  onChoose: (result: GeocodeResult) => void | Promise<void>;
  inputClassName?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

// A city search that suggests as you type: results appear under the field after
// a short pause, arrow keys move through them, Enter (or a click) picks one.
// The list floats over whatever is underneath instead of pushing it down.
export default function CityAutocomplete({ onChoose, inputClassName, placeholder = 'Search for a city', autoFocus }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState('');
  // Answers can arrive out of order; only the latest search may write results.
  const latest = useRef(0);
  const listId = useId();

  useEffect(() => {
    const text = query.trim();
    const ticket = ++latest.current;
    if (text.length < MIN_CHARS) {
      setResults([]);
      setMessage('');
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await invoke<GeocodeResult[]>('geocode_location', { query: text });
        if (ticket !== latest.current) return;
        setResults(found);
        setActive(0);
        setMessage(found.length === 0 ? "No matches. Try the city name, or 'City, ST'." : '');
      } catch {
        if (ticket !== latest.current) return;
        setResults([]);
        setMessage("Couldn't reach the search service. Check your connection.");
      } finally {
        if (ticket === latest.current) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const choose = async (result: GeocodeResult) => {
    latest.current += 1;
    try {
      await onChoose(result);
      setQuery('');
      setResults([]);
      setMessage('');
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSearching(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setActive((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setActive((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (results[active]) choose(results[active]);
    } else if (event.key === 'Escape' && (results.length > 0 || query)) {
      // First Escape clears the search; a second one is left for whatever
      // panel the field lives in to close itself.
      event.stopPropagation();
      latest.current += 1;
      setQuery('');
      setResults([]);
      setMessage('');
      setSearching(false);
    }
  };

  useEffect(() => {
    if (results.length === 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, results, listId]);

  const open = results.length > 0;

  return (
    <div className="cac">
      <div className="cac-field">
        <input
          autoFocus={autoFocus}
          className={inputClassName ?? 'cac-input'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-label="Search for a city"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="cac-status" aria-hidden>
          {searching ? <Loader2 size={14} className="cac-spin" /> : <Search size={14} />}
        </span>
        {open && (
          <ul className="cac-list" id={listId} role="listbox">
            {results.map((result, index) => (
              <li
                key={`${result.latitude},${result.longitude},${index}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'active' : ''}
                // Keep the caret in the field: a click must not blur it first.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(result)}
              >
                <MapPin size={13} />
                <span>{geocodeLabel(result)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {message && !open && <p className="cac-message">{message}</p>}
    </div>
  );
}
