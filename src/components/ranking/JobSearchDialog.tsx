"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileUp, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  saveAdzunaKey,
  saveJobSearch,
  sendTestEmail,
  suggestJobTitles,
} from "@/actions/jobSearch.actions";
import {
  EMAIL_MIN_SCORES,
  SEARCH_LIMITS,
  SEARCH_SOURCES,
  splitKeywords,
  type CareerSourceId,
  type JobSearchView,
  type SearchSourceId,
} from "@/models/jobSearch.model";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: JobSearchView | null;
  hasAdzunaKey: boolean;
  /** Whether SMTP is set up in .env, and where alerts would go. */
  email?: { configured: boolean; to: string | null };
  onSaved: (id: string, runNow: boolean) => void;
  /** Start by asking the AI for titles from the CVs ("Job list from my CVs"). */
  suggestOnOpen?: boolean;
}

interface Suggestion {
  title: string;
  fit: "core" | "adjacent";
  why: string;
}

/** Titles in `add` that `list` doesn't have yet, appended one per line. */
export function mergeTitles(list: string, add: string[]): { text: string; added: number } {
  const current = splitKeywords(list);
  const have = new Set(current.map((t) => t.toLowerCase()));
  const fresh = add.filter((t) => !have.has(t.toLowerCase()));
  return { text: [...current, ...fresh].join("\n"), added: fresh.length };
}

const DEFAULT_SOURCES: SearchSourceId[] = ["bundesagentur", "arbeitnow"];

export function JobSearchDialog({
  open,
  onOpenChange,
  search,
  hasAdzunaKey,
  email = { configured: false, to: null },
  onSaved,
  suggestOnOpen = false,
}: Props) {
  // Remounted per search (key on the parent), so the initial state is the form's reset.
  const [name, setName] = useState(search?.name ?? (suggestOnOpen ? "Jobs from my CVs" : ""));
  const [keywords, setKeywords] = useState(search ? splitKeywords(search.keywords).join("\n") : "");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const [location, setLocation] = useState(search?.location ?? "");
  const [radius, setRadius] = useState(String(search?.radiusKm ?? 50));
  const [age, setAge] = useState(String(search?.maxAgeDays ?? 7));
  const [daily, setDaily] = useState(search?.daily ?? true);
  const [emailAlerts, setEmailAlerts] = useState(search?.emailAlerts ?? false);
  const [emailMinScore, setEmailMinScore] = useState(String(search?.emailMinScore ?? 60));
  const [testing, setTesting] = useState(false);
  const [sources, setSources] = useState<Set<SearchSourceId>>(
    new Set(search?.sources ?? DEFAULT_SOURCES),
  );
  const [companies, setCompanies] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(search?.companies ?? {}).map(([k, v]) => [k, (v ?? []).join("\n")]),
    ),
  );
  const [adzunaId, setAdzunaId] = useState("");
  const [adzunaKey, setAdzunaKey] = useState("");
  const [saving, setSaving] = useState(false);

  const toggle = (id: SearchSourceId, on: boolean) =>
    setSources((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const needsAdzunaKey = sources.has("adzuna") && !hasAdzunaKey;
  const titleCount = splitKeywords(keywords).length;

  const suggest = async () => {
    setSuggesting(true);
    const res = await suggestJobTitles();
    setSuggesting(false);
    if (!res.success) {
      toastError(res.message);
      return;
    }
    const list = res.data ?? [];
    setSuggestions(list);
    setKeywords((prev) => {
      const { text, added } = mergeTitles(prev, list.map((t) => t.title));
      toastSuccess(`${added} job titles added from your CVs. Remove any you don't want.`);
      return text;
    });
  };

  // "Job list from my CVs" opens straight into the suggestion.
  const asked = useRef(false);
  useEffect(() => {
    if (!open || !suggestOnOpen || asked.current) return;
    asked.current = true;
    void suggest();
  }, [open, suggestOnOpen]);

  const testEmail = async () => {
    setTesting(true);
    const res = await sendTestEmail();
    setTesting(false);
    if (!res.success) toastError(res.message);
    else toastSuccess(`Test email sent to ${res.data?.to}. Check your inbox (and spam).`);
  };

  const download = () => {
    const blob = new Blob([`${splitKeywords(keywords).join("\n")}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "joblist.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importList = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    // One title per line; a CSV's first column also works.
    const titles = text
      .split(/\r?\n/)
      .map((line) => line.split(/[;,\t]/)[0].replace(/^"|"$/g, "").trim())
      .filter((t) => t && !/^(title|titel|job ?title|stellentitel)$/i.test(t));
    const { text: merged, added } = mergeTitles(keywords, titles);
    setKeywords(merged);
    toastSuccess(`${added} job titles imported.`);
    if (importInput.current) importInput.current.value = "";
  };

  const submit = async (runNow: boolean) => {
    setSaving(true);
    try {
      if (needsAdzunaKey || (sources.has("adzuna") && adzunaId && adzunaKey)) {
        const key = await saveAdzunaKey(adzunaId, adzunaKey);
        if (!key.success) {
          toastError(key.message);
          return;
        }
      }
      const res = await saveJobSearch(
        {
          name: name || splitKeywords(keywords)[0] || "Job search",
          keywords,
          location: location.trim() || undefined,
          radiusKm: Number(radius),
          maxAgeDays: Number(age),
          sources: [...sources],
          companies: Object.fromEntries(
            Object.entries(companies).map(([k, v]) => [k, v.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)]),
          ) as Partial<Record<CareerSourceId, string[]>>,
          daily,
          emailAlerts,
          emailMinScore: Number(emailMinScore),
        },
        search?.id,
      );
      if (!res.success) {
        toastError(res.message);
        return;
      }
      if (res.data?.ignoredCompanies.length) {
        toastError(`Couldn't read these company names: ${res.data.ignoredCompanies.join(", ")}`);
      } else {
        toastSuccess(search ? "Search saved" : "Search created");
      }
      onSaved(res.data!.id, runNow);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{search ? "Edit search" : "New job search"}</DialogTitle>
          <DialogDescription>
            JobSync asks each site you pick for new jobs, skips ones it found before, and ranks
            them against your CVs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <Label htmlFor="search-keywords">
                  Job list: titles to search, one per line ({titleCount} of {SEARCH_LIMITS.MAX_KEYWORDS})
                </Label>
                <div className="flex flex-wrap gap-1">
                  <Button type="button" size="sm" variant="secondary" disabled={suggesting} onClick={suggest}>
                    {suggesting ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1 h-3 w-3" />
                    )}
                    {suggesting ? "Reading your CVs…" : "Suggest from my CVs"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={titleCount === 0} onClick={download}>
                    <Download className="mr-1 h-3 w-3" /> Download
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => importInput.current?.click()}>
                    <FileUp className="mr-1 h-3 w-3" /> Import
                  </Button>
                  <input
                    ref={importInput}
                    type="file"
                    accept=".txt,.csv,text/plain,text/csv"
                    className="hidden"
                    data-testid="job-list-file"
                    onChange={(e) => importList(e.target.files?.[0])}
                  />
                </div>
              </div>
              <Textarea
                id="search-keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder={"IT-Administrator\nSystemadministrator\nIT Security Engineer"}
                className="min-h-32 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Each title is searched on its own, one after another, on every site. Sites without
                their own search keep jobs whose title contains one of these.
              </p>
              {suggestions.length > 0 && (
                <details className="rounded-md border p-2 text-xs">
                  <summary className="cursor-pointer font-medium">Why the AI suggested these</summary>
                  <ul className="mt-2 space-y-1">
                    {suggestions.map((t) => (
                      <li key={t.title}>
                        <span className="font-medium">{t.title}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {t.fit === "core" ? "main fit" : "realistic stretch"}
                          {t.why ? ` · ${t.why}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="search-location">Place (leave empty for all of Germany)</Label>
              <Input
                id="search-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Köln"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Radius</Label>
                <Select value={radius} onValueChange={setRadius}>
                  <SelectTrigger aria-label="Radius">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEARCH_LIMITS.RADIUS_OPTIONS.map((r) => (
                      <SelectItem key={r} value={String(r)}>
                        {r} km
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Posted within</Label>
                <Select value={age} onValueChange={setAge}>
                  <SelectTrigger aria-label="Posted within">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEARCH_LIMITS.AGE_OPTIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d === 1 ? "1 day" : `${d} days`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="search-name">Name</Label>
              <Input
                id="search-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="IT admin jobs in Köln"
              />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch id="search-daily" checked={daily} onCheckedChange={setDaily} />
              <Label htmlFor="search-daily">Run automatically every day</Label>
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Switch id="search-email" checked={emailAlerts} onCheckedChange={setEmailAlerts} />
              <Label htmlFor="search-email">Email me new matches</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              After each run, once the new jobs are scored, you get one email with the best ones. No
              email on days without new matches.
            </p>
            {emailAlerts && (
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label>Only jobs with a score of</Label>
                  <Select value={emailMinScore} onValueChange={setEmailMinScore}>
                    <SelectTrigger aria-label="Minimum score for email" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EMAIL_MIN_SCORES.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} or more
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!email.configured || testing}
                  onClick={testEmail}
                >
                  {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Send test email
                </Button>
              </div>
            )}
            {emailAlerts && (
              <p className="text-xs text-muted-foreground" data-testid="email-status">
                {email.configured
                  ? `Emails go to ${email.to ?? "your login email"}.`
                  : "Email is not set up yet: add BREVO_API_KEY and BREVO_SENDER (or a Gmail app password in SMTP_USER and SMTP_PASS) to the .env file and restart JobSync. You still get the bell notification."}
              </p>
            )}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Sites</legend>
            {SEARCH_SOURCES.map((s) => (
              <div key={s.id} className="rounded-md border p-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={sources.has(s.id)}
                    onChange={(e) => toggle(s.id, e.target.checked)}
                  />
                  <span>
                    <span className="text-sm font-medium">
                      {s.label}
                      {s.kind === "careers" && (
                        <span className="font-normal text-muted-foreground"> · company career pages</span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">{s.help}</span>
                  </span>
                </label>
                {s.kind === "careers" && sources.has(s.id) && (
                  <Textarea
                    aria-label={`${s.label} companies`}
                    className="mt-2 min-h-16 text-sm"
                    value={companies[s.id] ?? ""}
                    onChange={(e) => setCompanies((prev) => ({ ...prev, [s.id]: e.target.value }))}
                    placeholder="One company per line, or paste their careers links"
                  />
                )}
                {s.id === "adzuna" && sources.has("adzuna") && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      {hasAdzunaKey
                        ? "Your Adzuna key is saved. Fill these in only to replace it."
                        : "Create a free account at developer.adzuna.com, then copy your Application ID and Key here. They're stored encrypted."}
                    </p>
                    <Input
                      aria-label="Adzuna app id"
                      placeholder="Application ID"
                      value={adzunaId}
                      onChange={(e) => setAdzunaId(e.target.value)}
                    />
                    <Input
                      aria-label="Adzuna app key"
                      placeholder="Application key"
                      type="password"
                      value={adzunaKey}
                      onChange={(e) => setAdzunaKey(e.target.value)}
                    />
                  </div>
                )}
              </div>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            LinkedIn, Indeed, StepStone and XING don&apos;t allow automatic searches, so they can&apos;t be
            added. Many of their jobs also appear on the Bundesagentur and Adzuna.
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={saving} onClick={() => submit(false)}>
            Save
          </Button>
          <Button disabled={saving} onClick={() => submit(true)}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save and search now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
