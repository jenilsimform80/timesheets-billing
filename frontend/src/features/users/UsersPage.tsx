import { useCallback, useState } from 'react';
import type { User } from '../../api/types';
import {
  createUser,
  listUsers,
  resetUserPassword,
  updateUser,
  type NewUserInput,
  type UserPatch,
} from '../../api/users';
import { AsyncView } from '../../components/ui/AsyncView';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { Alert } from '../../components/ui/Alert';
import { EmptyState } from '../../components/ui/EmptyState';
import { describeError } from '../../components/ui/describeError';
import { useMutation } from '../../hooks/useMutation';
import { useAsync } from '../../hooks/useAsync';
import { useToast } from '../../components/ui/toast-context';
import styles from '../projects/Projects.module.css';
import { EditUserForm } from './EditUserForm';
import { ResetPasswordForm } from './ResetPasswordForm';
import { UserForm } from './UserForm';

const ROLE_LABEL = { CONTRIBUTOR: 'Contributor', MANAGER: 'Manager', ADMIN: 'Admin' } as const;

export function UsersPage() {
  const [creating, setCreating] = useState(false);
  const load = useCallback((signal: AbortSignal) => listUsers(signal), []);
  const { state, reload } = useAsync(load);

  const toast = useToast();
  const create = async (value: NewUserInput) => {
    await createUser(value);
    toast.success(`User ${value.name} was created.`);
    reload();
  };

  return (
    <>
      <h1>Users</h1>
      <p className="muted">
        Create contributor and manager accounts. A contributor reports to one manager, who approves
        their timesheets. Only admins can do this; the backend enforces it.
      </p>

      {!creating && <Button onClick={() => setCreating(true)}>New user</Button>}

      {creating && (
        <section className={styles.card} aria-label="Create user">
          <h2>New user</h2>
          <UserForm
            managers={managersFrom(state.status === 'success' ? state.data : [])}
            onSave={create}
            onCancel={() => setCreating(false)}
          />
        </section>
      )}

      <AsyncView
        state={state}
        onRetry={reload}
        loadingLabel="Loading users…"
        errorTitle="Could not load users"
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No users yet" />}
      >
        {(list) => {
          const nameOf = new Map(list.map((u) => [u.id, u.name]));
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Manager</th>
                    <th>Status</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((u) => (
                    <UserRows
                      key={u.id}
                      user={u}
                      managerName={u.managerId ? (nameOf.get(u.managerId) ?? '—') : '—'}
                      managers={managersFrom(list)}
                      onChanged={reload}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </AsyncView>
    </>
  );
}

const managersFrom = (list: User[]) =>
  list.filter((u) => u.role === 'MANAGER' && u.isActive !== false);

function UserRows({
  user,
  managerName,
  managers,
  onChanged,
}: {
  user: User;
  managerName: string;
  managers: User[];
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<'edit' | 'password' | null>(null);
  const toast = useToast();
  const toggle = useMutation(async () => {
    const activating = user.isActive === false;
    await updateUser(user.id, { isActive: activating });
    toast.success(`${user.name} was ${activating ? 'reactivated' : 'deactivated'}.`);
    onChanged();
  });
  const isAdmin = user.role === 'ADMIN';
  const close = () => setPanel(null);

  const save = async (patch: UserPatch) => {
    await updateUser(user.id, patch);
    toast.success(`${user.name} was updated.`);
    onChanged();
  };
  const setPassword = async (password: string) => {
    await resetUserPassword(user.id, password);
    toast.success(`Password reset for ${user.name}.`);
  };

  return (
    <>
      <tr>
        <td>{user.name}</td>
        <td>{user.email}</td>
        <td>{ROLE_LABEL[user.role]}</td>
        <td>{managerName}</td>
        <td>
          {user.isActive === false ? (
            <Badge tone="neutral">Inactive</Badge>
          ) : (
            <Badge tone="success">Active</Badge>
          )}
        </td>
        <td>
          {/* Admin accounts are not editable through the API; no actions that could only fail. */}
          {!isAdmin && (
            <ActionMenu
              label={`Actions for ${user.email}`}
              disabled={toggle.running}
              items={[
                { label: 'Edit', onSelect: () => setPanel('edit') },
                { label: 'Reset password', onSelect: () => setPanel('password') },
                {
                  label: user.isActive === false ? 'Reactivate' : 'Deactivate',
                  onSelect: () => void toggle.run(),
                  ...(user.isActive !== false && { tone: 'danger' as const }),
                },
              ]}
            />
          )}
        </td>
      </tr>
      {toggle.error && (
        <tr>
          <td colSpan={6}>
            <Alert variant="error">{describeError(toggle.error)}</Alert>
          </td>
        </tr>
      )}
      {panel && (
        <tr>
          <td colSpan={6}>
            {panel === 'edit' ? (
              <EditUserForm user={user} managers={managers} onSave={save} onCancel={close} />
            ) : (
              <ResetPasswordForm user={user} onSave={setPassword} onCancel={close} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}
