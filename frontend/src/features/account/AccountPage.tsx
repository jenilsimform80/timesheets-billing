import { useState, type FormEvent } from 'react';
import { changePassword } from '../../api/auth';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { PasswordField } from '../../components/ui/FormControls';
import { describeError } from '../../components/ui/describeError';
import { useAuth, useCurrentUser } from '../../auth/useAuth';
import { useMutation } from '../../hooks/useMutation';
import { useToast } from '../../components/ui/toast-context';
import { fieldErrorsFrom, MIN_PASSWORD_LENGTH } from '../../lib/forms';
import styles from '../projects/Projects.module.css';

export function AccountPage() {
  const user = useCurrentUser();
  const { markPasswordChanged } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const toast = useToast();
  const save = useMutation(changePassword);
  const errors = { ...fieldErrorsFrom(save.error), ...clientErrors };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (current === '') found['currentPassword'] = 'Enter your current password';
    if (next.length < MIN_PASSWORD_LENGTH)
      found['newPassword'] = `Use at least ${MIN_PASSWORD_LENGTH} characters`;
    else if (next !== confirm) found['confirm'] = 'The passwords do not match';
    setClientErrors(found);
    if (Object.keys(found).length > 0) return;

    const result = await save.run(current, next);
    if (result.ok) {
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Your password was changed.');
      markPasswordChanged();
    }
  };

  return (
    <>
      <h1>Account</h1>
      {user.mustChangePassword && (
        <Alert variant="warning" title="Choose a new password to continue">
          An admin reset your password, so they know the temporary one. Set your own below; the rest
          of the app unlocks as soon as you do.
        </Alert>
      )}
      <dl className={styles.facts}>
        <dt>Name</dt>
        <dd>{user.name}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
      </dl>

      <section className={styles.card} aria-label="Change password">
        <h2>Change password</h2>
        <p className="muted">
          Changing your password signs you out everywhere else. This device stays signed in.
        </p>
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="stack">
          {save.error && Object.keys(fieldErrorsFrom(save.error)).length === 0 && (
            <Alert variant="error">{describeError(save.error)}</Alert>
          )}
          <PasswordField
            label="Current password"
            autoComplete="current-password"
            value={current}
            error={errors['currentPassword']}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <PasswordField
            label="New password"
            autoComplete="new-password"
            value={next}
            error={errors['newPassword']}
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            onChange={(e) => setNext(e.target.value)}
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            value={confirm}
            error={errors['confirm']}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <div className="row">
            <Button type="submit" disabled={save.running}>
              {save.running ? 'Saving…' : 'Change password'}
            </Button>
          </div>
        </form>
      </section>
    </>
  );
}
