export default function PromotionDialog() {
    return (
        <div id="promotion-dialog" className="promotion-dialog" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
            <div className="promotion-tray">
                <span className="promotion-tray__title">Promote pawn to:</span>
                <div className="promotion-tray__pieces">
                    <button className="promotion-piece-btn" data-piece="q" aria-label="Queen">
                        <img src="" alt="Queen" draggable="false" />
                    </button>
                    <button className="promotion-piece-btn" data-piece="r" aria-label="Rook">
                        <img src="" alt="Rook" draggable="false" />
                    </button>
                    <button className="promotion-piece-btn" data-piece="b" aria-label="Bishop">
                        <img src="" alt="Bishop" draggable="false" />
                    </button>
                    <button className="promotion-piece-btn" data-piece="n" aria-label="Knight">
                        <img src="" alt="Knight" draggable="false" />
                    </button>
                </div>
            </div>
        </div>
    );
}
