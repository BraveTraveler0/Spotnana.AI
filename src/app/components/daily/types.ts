// Shapes returned by the Rust commands the Daily dashboard calls.

export interface DailyTask {
  id: string;
  label: string;
  done: boolean;
  source: string;
  note: string;
  // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local time); null when it has no day.
  when: string | null;
  // Part of town and cost, kept from the suggestion it was made from (older tasks have none).
  area?: string | null;
  cost?: string | null;
}

export interface ScheduledTaskInfo {
  id: string;
  title: string;
  prompt: string;
  hour: number;
  minute: number;
  last_run_date?: string | null;
}

export interface GoalSubStep {
  id: string;
  text: string;
  done: boolean;
}

export interface GoalItem {
  id: string;
  text: string;
  done: boolean;
  sub_steps: GoalSubStep[];
}

export interface GoalSection {
  title: string;
  level: number;
  group: string;
  items: GoalItem[];
}

// This week's progress on one of Iris's weekly goals (HermesKB\weekly-goals.json).
export interface WeeklyGoal {
  id: string;
  title: string;
  category: string;
  target: number;
  done: number;
  // The same goal over the calendar month.
  month_target: number;
  month_done: number;
}

export interface WeeklyGoals {
  // False until Iris has created the file.
  exists: boolean;
  updated: string;
  week_start: string;
  week_end: string;
  month_start: string;
  month_end: string;
  goals: WeeklyGoal[];
}

export interface IrisFeedSection {
  heading: string;
  content: string;
}

// One card of the Tasks panel, as Iris writes it (iris-feed/TASKS-CONTRACT.md).
export interface IrisTaskCard {
  id: string;
  title: string;
  detail: string;
  // calendar | goal | committed | scout | iris
  source: string;
  category: string;
  // Part of town / neighborhood, e.g. 'Doraville', 'Midtown'; null if unknown.
  area: string | null;
  // Human-readable cost, e.g. 'Free', '$12', '$40-ish'; null if unknown.
  cost: string | null;
  when: string | null;
  link: string | null;
  goal_id: string | null;
  // accept | dismiss
  action: string;
}

export interface IrisTasks {
  updated: string;
  next: IrisTaskCard[];
  suggested: IrisTaskCard[];
}

// One card of the Taste strip (iris-feed/TASKS-CONTRACT.md "recs"): a recipe or
// restaurant worth trying, shown as a horizontally scrolling row in Suggested.
export interface TasteRec {
  id: string;
  name: string;
  kind: string; // restaurant | wine-bar | brewery | recipe | cafe
  area: string | null;
  note: string;
  rating: string | null; // only ever a rating Iris actually found, e.g. '4.7'
  link: string | null;
  // Thumbnail picture on the card; null renders the plain card (no box).
  image: string | null;
}

// One weekly-review insight, fused: what changed, what to do about it, and the
// task "Add to tasks" creates (iris-feed/TASKS-CONTRACT.md).
export interface IrisInsight {
  id: string;
  observation: string;
  action: string;
  task: { title: string; category: string; when: string | null } | null;
  // drift | opportunity | decision
  kind: string;
  priority: number;
}

export interface IrisFeedContent {
  updated: string;
  brief_sections: IrisFeedSection[];
  events_sections: IrisFeedSection[];
  review_sections: IrisFeedSection[];
  spark_text: string;
  suggestion_text: string | null;
  suggestion_needs_answer: boolean;
  tasks: IrisTasks;
  insights: IrisInsight[];
  // Taste strip: restaurants / wine bars / recipes to try (optional; older feeds have none).
  recs: TasteRec[];
}

export interface WeatherInfo {
  temperature_f: number;
  condition: string;
  location: string;
  wind_mph: number;
  weather_code: number;
  is_day: boolean;
}

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  category: string;
  // Stories without a usable picture never reach the dashboard.
  image: string;
  image_width: number | null;
  summary: string;
}

export interface LocationInfo {
  label: string;
  latitude: number;
  longitude: number;
}

export interface GeocodeResult {
  name: string;
  // Short form that is saved and shown beside the weather: "Tucker, GA".
  label: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
}
