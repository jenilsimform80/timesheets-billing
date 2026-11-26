import { useCallback, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { listProjects } from '../../api/projects';
import { approveSubmission, getSubmission, rejectSubmission } from '../../api/submissions';
import { getWeek } from '../../api/timesheets';
import { getUser } from '../../api/users';
import type { Submission, User, WeekSummary, Project } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { AsyncView } from '../../components/ui/AsyncView';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { TextAreaField } from '../../components/ui/FormControls';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { describeError } from '../../components/ui/describeError';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import { useToast } from '../../components/ui/toast-context';
import { formatRange, formatTimestamp, weekDays } from '../../lib/dates';
import { DaySection } from '../timesheet/DaySection';
import { createProjectLookup } from '../timesheet/projectLookup';
import styles from '../timesheet/Timesheet.module.css';

interface Review {
  submission: Submission;
  week: WeekSummary;
  owner: User;
  projects: Project[];
}

export function ReviewPage() {
  const { submissionId = '' } = useParams();
  const load = useCallback(
    async (signal: AbortSignal): Promise<Review> => {
      const submission = await getSubmission(submissionId, signal);
      const [week, owner, projects] = await Promise.all([
        getWeek(submission.weekStart, submission.userId, signal),
        getUser(submission.userId, signal),
        listProjects({ signal }),
      ]);
      return { submission, week, owner, projects };
    },
    [submissionId],
  );
  const { state, reload } = useAsync(load);

  return (
    <>
      <p>
        <Link to="/approvals">‹ Back to approvals</Link>
      </p>
      <AsyncView
        state={state}
        onRetry={reload}
        loadingLabel="Loading the timesheet…"
        errorTitle="Could not load this timesheet"
      >
        {(review) => <ReviewContent review={review} onDecided={reload} />}
      </AsyncView>
    </>
  );
}

function ReviewContent({ review, onDecided }: { review: Review; onDecided: () => void }) {
  const { submission, week, owner, projects } = review;
  const toast = useToast();
  const lookup = createProjectLookup(projects);
  const byDay = new Map<string, typeof week.entries>();
  for (const e of week.entries) byDay.set(e.workDate, [...(byDay.get(e.workDate) ?? []), e]);
  // Reviewers only need days with logged time; empty weekdays and unworked weekends are noise.
  const workedDays = weekDays(week.weekStart).filter((date) => byDay.has(date));

  return (
    <div className="stack">
      <h1>
        {owner.name} <small className="muted">· {formatRange(week.weekStart, week.weekEnd)}</small>
      </h1>
      <div className={styles.summary}>
        <StatusBadge status={submission.status} />
        <span>
          <strong>{week.weeklyTotal} h</strong> total
        </span>
        <span>{week.billableTotal} h billable</span>
        <span>{week.nonBillableTotal} h non-billable</span>
        <span className="muted">Submitted {formatTimestamp(submission.submittedAt)}</span>
      </div>

      {week.warnings.length > 0 && (
        <Alert variant="warning" title="Hours worth a second look">
          <ul>
            {week.warnings.map((w) => (
              <li key={`${w.code}-${w.date ?? 'week'}`}>{w.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="stack">
        {workedDays.length === 0 && <p className="muted">No time logged this week.</p>}
        {workedDays.map((date) => (
          <DaySection
            key={date}
            date={date}
            entries={byDay.get(date) ?? []}
            total={week.dailyTotals[date] ?? 0}
            lookup={lookup}
          />
        ))}
      </div>

      {submission.status === 'SUBMITTED' ? (
        <DecisionForm
          submissionId={submission.id}
          onDecided={(decision) => {
            toast.success(
              `Timesheet ${decision}. ${owner.name} will see the result on their timesheet.`,
            );
            onDecided();
          }}
        />
      ) : (
        <Alert variant="info" title="Already decided">
          This timesheet was {submission.status === 'APPROVED' ? 'approved' : 'rejected'}; no
          further action is possible.
        </Alert>
      )}

      {submission.approvals && submission.approvals.length > 0 && (
        <section aria-labelledby="decisions-heading">
          <h2 id="decisions-heading">Decision history</h2>
          <ul>
            {submission.approvals.map((a) => (
              <li key={a.id}>
                <Badge tone={a.decision === 'APPROVED' ? 'success' : 'danger'}>
                  {a.decision === 'APPROVED' ? 'Approved' : 'Rejected'}
                </Badge>{' '}
                {formatTimestamp(a.decidedAt)}
                {a.comment && <> — “{a.comment}”</>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function DecisionForm({
  submissionId,
  onDecided,
}: {
  submissionId: string;
  onDecided: (decision: 'approved' | 'rejected') => void;
}) {
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | undefined>();

  const decide = useMutation(async (decision: 'approve' | 'reject') => {
    if (decision === 'approve') await approveSubmission(submissionId, comment.trim() || undefined);
    else await rejectSubmission(submissionId, comment.trim());
    onDecided(decision === 'approve' ? 'approved' : 'rejected');
  });

  const reject = async () => {
    if (comment.trim() === '') {
      setCommentError('Explain what needs to change so the contributor can fix it');
      return;
    }
    setCommentError(undefined);
    await decide.run('reject');
  };
  const approve = async () => {
    setCommentError(undefined);
    await decide.run('approve');
  };
  const onSubmit = (event: FormEvent) => event.preventDefault();

  return (
    <form onSubmit={onSubmit} aria-label="Decision" className="stack">
      {decide.error && <Alert variant="error">{describeError(decide.error)}</Alert>}
      <TextAreaField
        label="Comment"
        hint="Optional when approving; required when rejecting."
        rows={3}
        maxLength={1000}
        value={comment}
        error={commentError}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="row">
        <Button onClick={() => void approve()} disabled={decide.running}>
          Approve
        </Button>
        <Button variant="secondary" onClick={() => void reject()} disabled={decide.running}>
          Reject
        </Button>
      </div>
    </form>
  );
}
