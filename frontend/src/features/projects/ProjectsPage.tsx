import { useCallback, useState } from 'react';
import {
  createProject,
  createTask,
  listProjects,
  updateProject,
  updateTask,
  type ProjectInput,
  type ProjectPatch,
} from '../../api/projects';
import { listUsers } from '../../api/users';
import type { Project, User } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { AsyncView } from '../../components/ui/AsyncView';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CheckboxField } from '../../components/ui/FormControls';
import { describeError } from '../../components/ui/describeError';
import { useAuth } from '../../auth/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import { useToast } from '../../components/ui/toast-context';
import { formatRange } from '../../lib/dates';
import { ProjectForm } from './ProjectForm';
import styles from './Projects.module.css';
import { TaskList } from './TaskList';

export function ProjectsPage() {
  const { state: auth } = useAuth();
  const role = auth.status === 'authenticated' ? auth.user.role : undefined;
  const isAdmin = role === 'ADMIN';
  const canAddTasks = role === 'ADMIN' || role === 'MANAGER';
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const load = useCallback(
    (signal: AbortSignal) => listProjects({ includeArchived, signal }),
    [includeArchived],
  );
  const { state, reload } = useAsync(load);
  // Who can be a member or assignee: admins see everyone; a manager sees self + direct reports.
  const loadPeople = useCallback(
    (signal: AbortSignal) => (canAddTasks ? listUsers(signal) : Promise.resolve<User[]>([])),
    [canAddTasks],
  );
  const { state: peopleState } = useAsync(loadPeople);
  const people = (peopleState.status === 'success' ? peopleState.data : []).filter(
    (u) => u.role !== 'ADMIN' && u.isActive !== false,
  );

  const toast = useToast();
  const create = async (value: ProjectInput | ProjectPatch) => {
    await createProject(value as ProjectInput);
    toast.success('Project created.');
    reload();
  };

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Projects</h1>
        <div className={styles.toolbar}>
          {isAdmin && (
            <>
              <CheckboxField
                label="Show archived projects"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              {!creating && <Button onClick={() => setCreating(true)}>New project</Button>}
            </>
          )}
        </div>
      </div>

      {creating && isAdmin && (
        <section className={styles.card} aria-label="Create project">
          <h2>New project</h2>
          <ProjectForm people={people} onSave={create} onCancel={() => setCreating(false)} />
        </section>
      )}

      <AsyncView
        state={state}
        onRetry={reload}
        loadingLabel="Loading projects…"
        errorTitle="Could not load projects"
        isEmpty={(projects) => projects.length === 0}
        empty={
          <EmptyState
            title="No projects yet"
            description={
              isAdmin
                ? 'Create the first project above.'
                : 'An admin has not set up any projects yet.'
            }
          />
        }
      >
        {(projects) => (
          <div className="stack">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                isAdmin={isAdmin}
                canAddTasks={canAddTasks}
                people={people}
                onChanged={reload}
              />
            ))}
          </div>
        )}
      </AsyncView>
    </>
  );
}

function ProjectCard({
  project,
  isAdmin,
  canAddTasks,
  people,
  onChanged,
}: {
  project: Project;
  isAdmin: boolean;
  canAddTasks: boolean;
  people: User[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const toggle = useMutation(async () => {
    await updateProject(project.id, { isActive: !project.isActive });
    toast.success(`Project ${project.code} ${project.isActive ? 'archived' : 'restored'}.`);
    onChanged();
  });
  const headingId = `project-${project.id}`;

  const save = async (patch: ProjectInput | ProjectPatch) => {
    await updateProject(project.id, patch);
    toast.success(`Project ${project.code} was updated.`);
    onChanged();
  };

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <header className={styles.cardHeader}>
        <h2 id={headingId}>
          {project.code} · {project.name}
        </h2>
        {!project.isActive && <Badge tone="neutral">Archived</Badge>}
        {project.isRestricted && <Badge tone="neutral">Restricted</Badge>}
      </header>

      {editing && isAdmin ? (
        <ProjectForm
          project={project}
          people={people}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <dl className={styles.facts}>
            {project.clientName && (
              <>
                <dt>Client</dt>
                <dd>{project.clientName}</dd>
              </>
            )}
            {project.budgetHours !== undefined && (
              <>
                <dt>Budget</dt>
                <dd>{project.budgetHours} h</dd>
              </>
            )}
            {(project.startDate || project.endDate) && (
              <>
                <dt>Dates</dt>
                <dd>
                  {project.startDate && project.endDate
                    ? formatRange(project.startDate, project.endDate)
                    : (project.startDate ?? `until ${project.endDate}`)}
                </dd>
              </>
            )}
          </dl>
          {isAdmin && (
            <div className={styles.projectActions}>
              <Button
                variant="secondary"
                className={styles.small}
                onClick={() => setEditing(true)}
                aria-label={`Edit project ${project.code}`}
              >
                Edit
              </Button>
              <Button
                variant="secondary"
                className={styles.small}
                disabled={toggle.running}
                onClick={() => void toggle.run()}
                aria-label={`${project.isActive ? 'Archive' : 'Restore'} project ${project.code}`}
              >
                {project.isActive ? 'Archive' : 'Restore'}
              </Button>
            </div>
          )}
          {toggle.error && <Alert variant="error">{describeError(toggle.error)}</Alert>}
          {!project.isActive && isAdmin && (
            <p className="muted">
              Archived projects stay in reports but no new time can be logged.
            </p>
          )}
        </>
      )}

      <TaskList
        projectCode={project.code}
        tasks={project.tasks ?? []}
        // On a restricted project only members can be assigned (the backend enforces it too).
        people={
          project.isRestricted && project.memberIds
            ? people.filter((p) => project.memberIds?.includes(p.id))
            : people
        }
        {...(canAddTasks && {
          onAdd: async (name: string, assigneeIds: string[]) => {
            await createTask(project.id, name, assigneeIds);
            toast.success('Task added.');
            onChanged();
          },
          onUpdate: async (
            taskId: string,
            patch: { name?: string; isActive?: boolean; assigneeIds?: string[] },
          ) => {
            await updateTask(project.id, taskId, patch);
            toast.success('Task updated.');
            onChanged();
          },
        })}
      />
    </section>
  );
}
