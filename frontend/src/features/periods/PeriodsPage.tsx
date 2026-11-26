import { useCallback, useState, type FormEvent } from 'react';
import { listLockedPeriods, lockPeriod, unlockPeriod } from '../../api/periods';
import type { LockedPeriod } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { AsyncView } from '../../components/ui/AsyncView';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { TextAreaField, TextField } from '../../components/ui/FormControls';
import { describeError } from '../../components/ui/describeError';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import { useToast } from '../../components/ui/toast-context';
import { formatMonth, formatTimestamp } from '../../lib/dates';
import styles from '../projects/Projects.module.css';

const PERIOD = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/;

export function PeriodsPage() {
  const load = useCallback((signal: AbortSignal) => listLockedPeriods(signal), []);
  const { state, reload } = useAsync(load);

  return (
    <>
      <h1>Locked periods</h1>
      <p className="muted">
        Locking a month freezes every time entry dated in it — for everyone, admins included — so
        billed hours cannot change. The backend enforces this; unlocking requires a reason and is
        recorded in the audit trail.
      </p>

      <LockForm onLocked={reload} />

      <AsyncView
        state={state}
        onRetry={reload}
        loadingLabel="Loading locked periods…"
        errorTitle="Could not load locked periods"
        isEmpty={(periods) => periods.length === 0}
        empty={
          <EmptyState
            title="No months are locked"
            description="Lock a month once its hours have been billed."
          />
        }
      >
        {(periods) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Locked</th>
                  <th>By</th>
                  <th>Note</th>
                  <th>
                    <span className="visually-hidden">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <PeriodRow key={p.period} period={p} onUnlocked={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncView>
    </>
  );
}

function LockForm({ onLocked }: { onLocked: () => void }) {
  const [month, setMonth] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const toast = useToast();
  const lock = useMutation(async (period: string, text: string) => {
    await lockPeriod(period, text || undefined);
    toast.success(`${formatMonth(period)} is now locked.`);
    setMonth('');
    setNote('');
    onLocked();
  });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!PERIOD.test(month)) {
      setError('Choose the month to lock');
      return;
    }
    setError(undefined);
    await lock.run(month, note.trim());
  };

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      noValidate
      aria-label="Lock a month"
      className={`${styles.card} stack`}
    >
      <h2>Lock a month</h2>
      {lock.error && <Alert variant="error">{describeError(lock.error)}</Alert>}
      <div className="row">
        <TextField
          label="Month"
          type="month"
          value={month}
          error={error}
          onChange={(e) => setMonth(e.target.value)}
        />
        <TextField
          label="Note (optional)"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button type="submit" disabled={lock.running}>
          {lock.running ? 'Locking…' : 'Lock month'}
        </Button>
      </div>
    </form>
  );
}

function PeriodRow({ period, onUnlocked }: { period: LockedPeriod; onUnlocked: () => void }) {
  const [unlocking, setUnlocking] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const toast = useToast();
  const unlock = useMutation(async (text: string) => {
    await unlockPeriod(period.period, text);
    toast.success(`${formatMonth(period.period)} was unlocked.`);
    onUnlocked();
  });
  const label = formatMonth(period.period);

  const confirm = async () => {
    if (reason.trim().length < 3) {
      setReasonError('Give a reason (at least 3 characters); it is written to the audit trail');
      return;
    }
    setReasonError(undefined);
    await unlock.run(reason.trim());
  };

  return (
    <>
      <tr>
        <td>{label}</td>
        <td>{formatTimestamp(period.lockedAt)}</td>
        <td>{period.lockedBy.name}</td>
        <td>{period.note ?? '—'}</td>
        <td>
          {!unlocking && (
            <Button
              variant="secondary"
              onClick={() => setUnlocking(true)}
              aria-label={`Unlock ${label}`}
            >
              Unlock
            </Button>
          )}
        </td>
      </tr>
      {unlocking && (
        <tr>
          <td colSpan={5}>
            <form
              aria-label={`Unlock ${label}`}
              onSubmit={(e) => e.preventDefault()}
              className="stack"
            >
              <Alert variant="warning" title={`Unlock ${label}?`}>
                Entries in this month become editable again. This is recorded in the audit trail
                with your reason.
              </Alert>
              {unlock.error && <Alert variant="error">{describeError(unlock.error)}</Alert>}
              <TextAreaField
                label="Reason"
                rows={2}
                maxLength={500}
                value={reason}
                error={reasonError}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="row">
                <Button onClick={() => void confirm()} disabled={unlock.running}>
                  {unlock.running ? 'Unlocking…' : 'Unlock month'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setUnlocking(false)}
                  disabled={unlock.running}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
