import { useState } from 'react';
import { getSubmission, submitWeek } from '../../api/submissions';
import type { WeekSummary } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { describeError } from '../../components/ui/describeError';
import { useCurrentUser } from '../../auth/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import { useToast } from '../../components/ui/toast-context';
import { formatTimestamp } from '../../lib/dates';
import { useCallback } from 'react';
import styles from './Timesheet.module.css';

interface SubmissionPanelProps {
  week: WeekSummary;
  /** Called after a successful submit so the page reloads the week. */
  onSubmitted: () => void;
}

/** Shows the review status of the week and lets the owner (re)submit it. */
export function SubmissionPanel({ week, onSubmitted }: SubmissionPanelProps) {
  const user = useCurrentUser();
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const submit = useMutation(async () => {
    await submitWeek(week.weekStart);
    toast.success('Timesheet submitted for approval.');
    setConfirming(false);
    onSubmitted();
  });
  const canSubmit = week.status === 'DRAFT' || week.status === 'REJECTED';
  const empty = week.entries.length === 0;

  return (
    <section aria-label="Submission" className="stack">
      {week.status === 'SUBMITTED' && (
        <Alert variant="info" title="Submitted">
          {week.submission && <>Sent {formatTimestamp(week.submission.submittedAt)}. </>}
          Waiting for your manager (or an admin, if you have none). Editing is locked until they
          decide.
        </Alert>
      )}
      {week.status === 'APPROVED' && (
        <Alert variant="success" title="Approved">
          Your manager approved this week. It can no longer be edited.
        </Alert>
      )}
      {week.status === 'REJECTED' && week.submission && (
        <RejectionNotice submissionId={week.submission.id} />
      )}

      {canSubmit && !user.managerId && (
        <Alert variant="info" title="No manager assigned">
          You have no manager, so this timesheet will be sent to an admin for approval by default.
        </Alert>
      )}

      {submit.error && <Alert variant="error">{describeError(submit.error)}</Alert>}

      {canSubmit && !confirming && (
        <div>
          <Button onClick={() => setConfirming(true)} disabled={empty}>
            {week.status === 'REJECTED' ? 'Resubmit week for approval' : 'Submit week for approval'}
          </Button>
          {empty && <p className="muted">Add at least one entry to submit this week.</p>}
        </div>
      )}
      {canSubmit && confirming && (
        <div role="group" aria-label="Confirm submit" className={styles.confirmBar}>
          <span>
            Submit this week? You will not be able to edit it until your manager (or an admin, if
            you have none) decides.
          </span>
          <div className={styles.confirmActions}>
            <Button onClick={() => void submit.run()} disabled={submit.running}>
              {submit.running ? 'Submitting…' : 'Yes, submit'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={submit.running}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function RejectionNotice({ submissionId }: { submissionId: string }) {
  const load = useCallback(
    (signal: AbortSignal) => getSubmission(submissionId, signal),
    [submissionId],
  );
  const { state } = useAsync(load);
  const rejection =
    state.status === 'success'
      ? [...(state.data.approvals ?? [])].reverse().find((a) => a.decision === 'REJECTED')
      : undefined;

  return (
    <Alert variant="warning" title="Rejected: please fix and resubmit">
      {state.status === 'loading' && 'Loading the manager’s reason…'}
      {state.status === 'error' &&
        'Your manager rejected this week. (The reason could not be loaded.)'}
      {state.status === 'success' &&
        (rejection?.comment ? (
          <>Manager’s reason: “{rejection.comment}”</>
        ) : (
          'Your manager rejected this week.'
        ))}{' '}
      You can edit the entries again and resubmit.
    </Alert>
  );
}
