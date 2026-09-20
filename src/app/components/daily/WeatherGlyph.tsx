import { Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun } from 'lucide-react';

// WMO weather codes as Open-Meteo reports them.
export default function WeatherGlyph({ code, isDay, size = 34 }: { code: number; isDay: boolean; size?: number }) {
  const props = { size, strokeWidth: 1.25 };

  if (code === 0) return isDay ? <Sun {...props} /> : <Moon {...props} />;
  if (code === 1 || code === 2) return isDay ? <CloudSun {...props} /> : <CloudMoon {...props} />;
  if (code === 3) return <Cloud {...props} />;
  if (code === 45 || code === 48) return <CloudFog {...props} />;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return <CloudRain {...props} />;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow {...props} />;
  if (code >= 95) return <CloudLightning {...props} />;
  return <Cloud {...props} />;
}
