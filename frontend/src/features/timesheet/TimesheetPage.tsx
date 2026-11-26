import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { listLockedPeriods } from '../../api/periods';
import { listProjects } from '../../api/projects';
import {
  createEntry,
  deleteEntry,
  getWeek,
  updateEntry,
  type EntryInput,
  type EntryPatch,
} from '../../api/timesheets';
import type { TimeEntry, WeekSummary } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { AsyncView } from '../../components/ui/AsyncView';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { combineAsync } from '../../hooks/combineAsync';
import { useAsync } from '../../hooks/useAsync';
import { useToast } from '../../components/ui/toast-context';
import { isValidIsoDate, mondayOf, monthOf, todayIso, weekDays } from '../../lib/dates';
import { DaySection } from './DaySection';
import { createProjectLookup } from './projectLookup';
import { SubmissionHistory } from './SubmissionHistory';
import { SubmissionPanel } from './SubmissionPanel';
import styles from './Timesheet.module.css';
import { WeekNavigator } from './WeekNavigator';

function resolveWeek(param: string | null): string {
  return mondayOf(param && isValidIsoDate(param) ? param : todayIso());
}

export function TimesheetPage() {
  const [params, setParams] = useSearchParams();
  const weekStart = resolveWeek(params.get('week'));
  const [historyKey, setHistoryKey] = useState(0);

  const loadWeek = useCallback(
    (signal: AbortSignal) => getWeek(weekStart, undefined, signal),
    [weekStart],
  );
  const loadProjects = useCallback((signal: AbortSignal) => listProjects({ signal }), []);
  const loadLocked = useCallback((signal: AbortSignal) => listLockedPeriods(signal), []);
  const week = useAsync(loadWeek);
  const projects = useAsync(loadProjects);
  const locked = useAsync(loadLocked);

  const changeWeek = (next: string) => setParams({ week: next });
  const refresh = () => {
    week.reload();
    setHistoryKey((k) => k + 1);
  };

  const toast = useToast();
  // These reject on failure; the form/row that called them catches via useMutation and shows why.
  const create = async (value: EntryInput) => {
    await createEntry(value);
    toast.success('Entry added.');
    week.reload();
  };
  const update = async (id: string, patch: EntryPatch) => {
    await updateEntry(id, patch);
    toast.success('Entry updated.');
    week.reload();
  };
  const remove = async (id: string) => {
    await deleteEntry(id);
    toast.success('Entry deleted.');
    week.reload();
  };

  const state = combineAsync({ week: week.state, projects: projects.state, locked: locked.state });
  const retryAll = () => {
    week.reload();
    projects.reload();
    locked.reload();
  };

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Timesheet</h1>
        <WeekNavigator
          weekStart={weekStart}
          weekEnd={
            week.state.status === 'success' ? week.state.data.weekEnd : weekDays(weekStart)[6]!
          }
          onChange={changeWeek}
        />
      </div>

      <AsyncView
        state={state}
        onRetry={retryAll}
        loadingLabel="Loading your timesheet…"
        errorTitle="Could not load your timesheet"
      >
        {({ week: data, projects: activeProjects, locked: lockedPeriods }) => {
          const lockedMonths = new Set(lockedPeriods.map((p) => p.period));
          const lookup = createProjectLookup(activeProjects);
          const frozen = data.status === 'SUBMITTED' || data.status === 'APPROVED';
          const entriesByDay = groupByDay(data);
          return (
            <div className="stack">
              <div className={styles.summary}>
                <StatusBadge status={data.status} />
                <span>
                  <strong>{data.weeklyTotal} h</strong> total
                </span>
                <span>{data.billableTotal} h billable</span>
                <span>{data.nonBillableTotal} h non-billable</span>
              </div>

              {data.warnings.length > 0 && (
                <Alert variant="warning" title="Heads-up (does not stop you saving)">
                  <ul>
                    {data.warnings.map((w) => (
                      <li key={`${w.code}-${w.date ?? 'week'}`}>{w.message}</li>
                    ))}
                  </ul>
                </Alert>
              )}

              <SubmissionPanel week={data} onSubmitted={refresh} />

              <div className="stack">
                {weekDays(data.weekStart).map((date) => (
                  <DaySection
                    key={date}
                    date={date}
                    entries={entriesByDay.get(date) ?? []}
                    total={data.dailyTotals[date] ?? 0}
                    lookup={lookup}
                    projects={activeProjects}
                    weekStart={data.weekStart}
                    weekEnd={data.weekEnd}
                    lockedReason={
                      frozen
                        ? 'This week is submitted and cannot be edited.'
                        : lockedMonths.has(monthOf(date))
                          ? 'This month is locked for billing.'
                          : undefined
                    }
                    onCreate={create}
                    onUpdate={update}
                    onDelete={remove}
                  />
                ))}
              </div>
            </div>
          );
        }}
      </AsyncView>

      <SubmissionHistory reloadKey={String(historyKey)} />
    </>
  );
}

function groupByDay(week: WeekSummary): Map<string, TimeEntry[]> {
  const map = new Map<string, TimeEntry[]>();
  for (const entry of week.entries) {
    map.set(entry.workDate, [...(map.get(entry.workDate) ?? []), entry]);
  }
  return map;
}
