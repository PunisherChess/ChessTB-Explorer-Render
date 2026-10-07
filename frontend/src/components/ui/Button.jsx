import Icon from './Icon.jsx';

export default function Button({ variant, compact, grow, iconOnly, icon, className = '', children, ...rest }) {
    const cls = [
        'btn',
        variant === 'primary' && 'btn--apply',
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
