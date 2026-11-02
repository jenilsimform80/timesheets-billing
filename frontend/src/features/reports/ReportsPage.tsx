import { useCallback, useState, type FormEvent } from 'react';
import { listProjects } from '../../api/projects';
import { getHoursReport, type HoursReportParams } from '../../api/reports';
import { listUsers } from '../../api/users';
import type { HoursReport, HoursRow, ReportDimension } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { AsyncView } from '../../components/ui/AsyncView';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CheckboxField, SelectField, TextField } from '../../components/ui/FormControls';
import { useAuth } from '../../auth/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { daysInclusive, formatMonth, isValidIsoDate, todayIso } from '../../lib/dates';
import { useMutation } from '../../hooks/useMutation';
import { downloadHoursReportPdf } from '../../lib/report-pdf';
import styles from './Reports.module.css';

const MAX_RANGE_DAYS = 1830; // keep in step with the backend limit (docs/api-contracts.md)

const DIMENSIONS: { value: ReportDimension; label: string }[] = [
  { value: 'contributor', label: 'Contributor' },
  { value: 'project', label: 'Project' },
  { value: 'month', label: 'Month' },
];

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function ReportsPage() {
  const { state: auth } = useAuth();
  const user = auth.status === 'authenticated' ? auth.user : null;
  const canPickPerson = user?.role === 'MANAGER' || user?.role === 'ADMIN';

  const today = todayIso();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<ReportDimension[]>(['month']);
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | undefined>();
  // The filters being edited vs the ones the shown report was run with.
  const [applied, setApplied] = useState<HoursReportParams>({
    from: monthStart(today),
    to: today,
    groupBy: ['month'],
  });

  const loadReport = useCallback(
    (signal: AbortSignal) => getHoursReport(applied, signal),
    [applied],
  );
  const loadProjects = useCallback(
    (signal: AbortSignal) => listProjects({ includeArchived: user?.role === 'ADMIN', signal }),
    [user?.role],
  );
  const loadUsers = useCallback(
    (signal: AbortSignal) => (canPickPerson ? listUsers(signal) : Promise.resolve([])),
    [canPickPerson],
  );
  const report = useAsync(loadReport);
  const projects = useAsync(loadProjects);
  const people = useAsync(loadUsers);

  const toggle = (dim: ReportDimension) =>
    setGroupBy((current) =>
      current.includes(dim) ? current.filter((d) => d !== dim) : [...current, dim],
    );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!isValidIsoDate(from) || !isValidIsoDate(to)) return setError('Choose both dates');
    if (from > to) return setError('The start date cannot be after the end date');
    if (daysInclusive(from, to) > MAX_RANGE_DAYS)
      return setError('Choose a range of at most 5 years');
    if (groupBy.length === 0) return setError('Choose at least one thing to group by');
    setError(undefined);
    // Keep the order contributor → project → month regardless of click order.
    const ordered = DIMENSIONS.map((d) => d.value).filter((d) => groupBy.includes(d));
    setApplied({
      from,
      to,
      groupBy: ordered,
      ...(projectId && { projectId }),
      ...(userId && { userId }),
    });
  };

  const projectOptions = projects.state.status === 'success' ? projects.state.data : [];
  const peopleOptions = people.state.status === 'success' ? people.state.data : [];

  // The PDF is exactly the report on screen; there is nothing to export when it is empty or failed.
  const shown =
    report.state.status === 'success' && report.state.data.rows.length > 0
      ? report.state.data
      : null;
  const exportPdf = useCallback(async () => {
    if (!shown) return;
    const projectList = projects.state.status === 'success' ? projects.state.data : [];
    const peopleList = people.state.status === 'success' ? people.state.data : [];
    await downloadHoursReportPdf(shown, {
      generatedBy: user?.name ?? '',
      generatedOn: todayIso(),
      filters: [
        ...(applied.projectId
          ? [`Project: ${labelOfProject(projectList, applied.projectId)}`]
          : []),
        ...(applied.userId
          ? [`Person: ${peopleList.find((p) => p.id === applied.userId)?.name ?? ''}`]
          : []),
      ],
    });
  }, [shown, user?.name, applied, projects.state, people.state]);
  const download = useMutation(exportPdf);

  return (
    <>
      <h1>Hours report</h1>
      <p className="muted">
        {user?.role === 'ADMIN'
          ? 'Everyone’s logged hours.'
          : user?.role === 'MANAGER'
            ? 'Your hours and your direct reports’ hours.'
            : 'Your logged hours.'}
      </p>

      <form onSubmit={onSubmit} noValidate aria-label="Report filters" className="stack">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="row">
          <TextField
            label="From"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <SelectField
            label="Project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">All projects</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
                {p.isActive ? '' : ' (archived)'}
              </option>
            ))}
          </SelectField>
          {canPickPerson && (
            <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Everyone I can see</option>
              {peopleOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
          )}
        </div>
        <fieldset>
          <legend>Group by</legend>
          <div className="row">
            {DIMENSIONS.map((d) => (
              <CheckboxField
                key={d.value}
                label={d.label}
                checked={groupBy.includes(d.value)}
                onChange={() => toggle(d.value)}
              />
            ))}
          </div>
        </fieldset>
        <div className={styles.actions}>
          <Button type="submit">Run report</Button>
          {shown && (
            <Button
              variant="secondary"
              onClick={() => void download.run()}
              disabled={download.running}
            >
              {download.running ? 'Creating PDF…' : 'Download PDF'}
            </Button>
          )}
        </div>
        {download.error && (
          <Alert variant="error">Could not create the PDF. Please try again.</Alert>
        )}
      </form>

      <section aria-label="Report results" className={styles.results}>
        <AsyncView
          state={report.state}
          onRetry={report.reload}
          loadingLabel="Running the report…"
          errorTitle="Could not run the report"
          isEmpty={(data) => data.rows.length === 0}
          empty={
            <EmptyState
              title="No hours in this range"
              description="Try a wider date range or different filters."
            />
          }
        >
          {(data) => <ReportTable report={data} />}
        </AsyncView>
      </section>
    </>
  );
}

function labelOfProject(projects: { id: string; code: string; name: string }[], id: string) {
  const p = projects.find((candidate) => candidate.id === id);
  return p ? `${p.code} · ${p.name}` : '';
}

function ReportTable({ report }: { report: HoursReport }) {
  const dims = report.groupBy;
  return (
    <div className="stack">
      {report.truncated && (
        <Alert variant="warning" title="Showing the first 5000 rows">
          There is more data than fits in one report. Narrow the date range or add a filter to see
          the rest.
        </Alert>
      )}
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">
            Hours from {report.from} to {report.to}
          </caption>
          <thead>
            <tr>
              {dims.includes('contributor') && <th>Contributor</th>}
              {dims.includes('project') && <th>Project</th>}
              {dims.includes('month') && <th>Month</th>}
              <th className="num">Total h</th>
              <th className="num">Billable h</th>
              <th className="num">Non-billable h</th>
              <th className="num">Entries</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, i) => (
              <tr key={i}>
                {dims.includes('contributor') && <td>{row.userName}</td>}
                {dims.includes('project') && <td>{projectLabel(row)}</td>}
                {dims.includes('month') && <td>{row.month ? formatMonth(row.month) : ''}</td>}
                <td className="num">{row.totalHours}</td>
                <td className="num">{row.billableHours}</td>
                <td className="num">{row.nonBillableHours}</td>
                <td className="num">{row.entryCount}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={dims.length}>Total</td>
              <td className="num">{report.totals.totalHours}</td>
              <td className="num">{report.totals.billableHours}</td>
              <td className="num">{report.totals.nonBillableHours}</td>
              <td className="num">{report.totals.entryCount}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function projectLabel(row: HoursRow): string {
  return row.projectCode ? `${row.projectCode} · ${row.projectName ?? ''}` : '';
}
