"use client";

import { format } from "date-fns";
import { FileUser } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { cn } from "@/lib/utils";
import { scoreBand } from "./scoreBand";

interface BestCvBadgeProps {
  score?: number | null;
  title?: string | null;
  comparedAt?: Date | string | null;
  className?: string;
}

/**
 * The best score from "Compare all my CVs", shown beside a job title. Hover
 * (or focus) names the CV that scored it.
 */
export function BestCvBadge({ score, title, comparedAt, className }: BestCvBadgeProps) {
  if (score == null || !title) return null;
  const band = scoreBand(score);
  const when = comparedAt ? format(new Date(comparedAt), "PP") : null;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              "inline-flex h-5 shrink-0 cursor-default items-center gap-0.5 rounded-md px-1.5 text-xs font-semibold",
              band.className,
              className,
            )}
            aria-label={`Best CV match ${score} of 100: ${title}`}
            data-testid="best-cv-badge"
          >
            <FileUser className="h-3 w-3" aria-hidden="true" />
            {score}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-medium">Best CV: {title}</p>
          <p className="text-xs opacity-80">
            {band.label} match, {score}/100{when ? ` · compared ${when}` : ""}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
