// Maps what a posting (or the AI reading it) says about the role onto the Add
// Job form's options, in English and German. Order matters: the first rule
// that matches wins, so the more specific terms come first.

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

const WORKPLACE_RULES: [RegExp, string][] = [
  [/hybrid|teilweise (remote|mobil|homeoffice)|mobiles arbeiten moglich|teils remote/, "HYBRID"],
  [/remote|home ?office|homeoffice|mobiles arbeiten|von zu hause|telearbeit|work from home|wfh/, "REMOTE"],
  [/on ?site|onsite|vor ort|in office|im buro|prasenz|office/, "ONSITE"],
];

const JOB_TYPE_RULES: [RegExp, string][] = [
  [/contract|freelance|freiberuf|\bbefristet|temporar|zeitarbeit|arbeitnehmeruberlassung|werkvertrag|interim|fixed[- ]term|temp\b/, "C"],
  [/part[- ]?time|teilzeit|minijob|werkstudent|working student|aushilfe/, "PT"],
  [/full[- ]?time|vollzeit|unbefristet|permanent|festanstellung/, "FT"],
];

function mapTerm(rules: [RegExp, string][], input: string): string | undefined {
  const text = fold(input.trim());
  if (!text) return undefined;
  return rules.find(([re]) => re.test(text))?.[1];
}

/** "Hybrid", "Homeoffice", "vor Ort" … → HYBRID | REMOTE | ONSITE */
export function workplaceTypeCode(input: string): string | undefined {
  return mapTerm(WORKPLACE_RULES, input);
}

/** "Full-time", "Vollzeit", "Teilzeit", "befristet" … → FT | PT | C */
export function jobTypeCode(input: string): string | undefined {
  return mapTerm(JOB_TYPE_RULES, input);
}

// "(m/w/d)", "(w/m/d)", "(m/f/d)", "(gn)", "(all genders)", "(d/m/w)" and the
// like: German postings carry them in nearly every title, and they would make
// one job title per marker in the user's list.
const GENDER_MARKER =
  /\s*[([]\s*(?:(?:[mwfdxi]|gn|div)\s*\*?\s*[/|,]\s*)+(?:[mwfdxi]|gn|div)\s*\*?\s*[)\]]|\s*[([]\s*(?:[mwfdxi]{3}|gn\*?|all genders|alle geschlechter)\s*[)\]]/gi;

export function cleanJobTitle(title: string): string {
  return title.replace(GENDER_MARKER, "").replace(/\s{2,}/g, " ").trim();
}
