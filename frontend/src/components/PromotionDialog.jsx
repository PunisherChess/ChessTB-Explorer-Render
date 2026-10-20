import { memo } from 'react';

const PIECES = [['q', 'Queen'], ['r', 'Rook'], ['b', 'Bishop'], ['n', 'Knight']];

// board.js sets each image src for the active piece set and promoting colour.
function PromotionDialog() {
    return (
        <div id="promotion-dialog" className="promotion-dialog" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
            <div className="promotion-tray">
                <span className="promotion-tray__title">Promote pawn to:</span>
                <div className="promotion-tray__pieces">
                    {PIECES.map(([letter, name]) => (
                        <button key={letter} className="promotion-piece-btn" data-piece={letter} aria-label={name}>
                            <img src="" alt={name} draggable="false" />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default memo(PromotionDialog);
