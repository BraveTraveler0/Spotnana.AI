import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown } from 'lucide-react';
import CityAutocomplete, { geocodeLabel } from './CityAutocomplete';
import type { GeocodeResult } from './types';

// Same commands the Settings location search uses, so a place picked here and
// one picked there are the same saved location.
export default function LocationPicker({ label, onChanged }: { label: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const choose = async (result: GeocodeResult) => {
    await invoke('set_location', { label: geocodeLabel(result), latitude: result.latitude, longitude: result.longitude });
    setOpen(false);
    onChanged();
  };

  return (
    <div className="dd-location" ref={rootRef}>
      <button type="button" className="dd-drop" onClick={() => setOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={open}>
        {label}
        <ChevronDown size={13} className={open ? 'open' : ''} />
      </button>
      {open && (
        <div className="dd-popover" role="dialog" aria-label="Change location">
          <CityAutocomplete autoFocus onChoose={choose} />
        </div>
      )}
    </div>
  );
}
