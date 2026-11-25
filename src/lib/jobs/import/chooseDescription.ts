// Which description the Add Job form gets after reading a posting.

// The same floor Job Match applies (preprocessing-job.ts): below it, Match
// refuses the job, so the form says so straight away.
const MATCHABLE_DESCRIPTION_CHARS = 200;

const plainLength = (s: string) =>
  s.replace(/[#*_>`\-]/g, " ").replace(/\s+/g, " ").trim().length;

/**
 * The page's own description wins over the model's copy unless the copy is
 * about as long: long postings (German ones especially) come back from the
 * model cut short, and a short description is what makes Job Match refuse.
 */
export function chooseDescription(
  modelMarkdown: string,
  pageText: string | null,
): string {
  const fromModel = modelMarkdown.trim();
  if (!pageText) return fromModel;
  return plainLength(fromModel) >= plainLength(pageText) * 0.8
    ? fromModel
    : pageText;
}

export function descriptionTooShortForMatch(description: string): boolean {
  return plainLength(description) < MATCHABLE_DESCRIPTION_CHARS;
}
