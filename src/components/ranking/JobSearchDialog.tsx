"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
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
import { saveAdzunaKey, saveJobSearch } from "@/actions/jobSearch.actions";
import {
  SEARCH_LIMITS,
  SEARCH_SOURCES,
  type CareerSourceId,
  type JobSearchView,
  type SearchSourceId,
} from "@/models/jobSearch.model";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: JobSearchView | null;
  hasAdzunaKey: boolean;
  onSaved: (id: string, runNow: boolean) => void;
}

const DEFAULT_SOURCES: SearchSourceId[] = ["bundesagentur", "arbeitnow"];

export function JobSearchDialog({ open, onOpenChange, search, hasAdzunaKey, onSaved }: Props) {
  // Remounted per search (key on the parent), so the initial state is the form's reset.
  const [name, setName] = useState(search?.name ?? "");
  const [keywords, setKeywords] = useState(search?.keywords ?? "");
  const [location, setLocation] = useState(search?.location ?? "");
  const [radius, setRadius] = useState(String(search?.radiusKm ?? 50));
  const [age, setAge] = useState(String(search?.maxAgeDays ?? 7));
  const [daily, setDaily] = useState(search?.daily ?? true);
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
          name: name || keywords.split(",")[0] || "Job search",
          keywords,
          location: location.trim() || undefined,
          radiusKm: Number(radius),
          maxAgeDays: Number(age),
          sources: [...sources],
          companies: Object.fromEntries(
            Object.entries(companies).map(([k, v]) => [k, v.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)]),
          ) as Partial<Record<CareerSourceId, string[]>>,
          daily,
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
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="search-keywords">Keywords (comma-separated, any can match)</Label>
              <Input
                id="search-keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="IT-Administrator, Systemadministrator, IT Security"
              />
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
