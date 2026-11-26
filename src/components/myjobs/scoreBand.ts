// Same bands as the Job Match prompt's scoring guidelines.
export function scoreBand(score: number): { label: string; className: string } {
  if (score >= 80) return { label: "Strong", className: "bg-emerald-600 text-white" };
  if (score >= 65) return { label: "Good", className: "bg-teal-600 text-white" };
  if (score >= 50) return { label: "Partial", className: "bg-amber-500 text-white" };
  return { label: "Weak", className: "bg-rose-600 text-white" };
}
