import { useSession } from '../app/session';
import { Button, type ButtonProps } from './button';

export const OPERATOR_REQUIRED = 'Cần quyền operator';

/**
 * A mutation button: viewers see it disabled with the "Cần quyền operator"
 * tooltip (also on the wrapper, since disabled buttons do not show tooltips
 * in every browser). `disabledReason` disables it for operators with an
 * explanation. The wrapper is always rendered so the button keeps its DOM
 * identity (and focus) when it becomes enabled.
 */
export function OperatorButton({ disabledReason, title, disabled, ...props }: ButtonProps & { disabledReason?: string | null }) {
  const { canOperate } = useSession();
  const reason = !canOperate ? OPERATOR_REQUIRED : disabledReason || null;
  return (
    <span title={reason ?? undefined} className="inline-flex">
      <Button {...props} disabled={disabled || reason !== null} title={reason ?? title} />
    </span>
  );
}
