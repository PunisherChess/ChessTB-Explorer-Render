/** Button.jsx: shared button primitive */

import Icon from './Icon.jsx';

export default function Button({ compact, grow, iconOnly, icon, className = '', children, ...rest }) {
    const cls = [
        'btn',
        compact && 'btn--compact',
        grow && 'btn--grow',
        iconOnly && 'btn--icon-only',
        className,
    ].filter(Boolean).join(' ');
    return (
        <button type="button" className={cls} {...rest}>
            {icon && <Icon name={icon} className="btn__icon" />}
            {children}
        </button>
    );
}
