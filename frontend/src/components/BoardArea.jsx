import Segmented from './ui/Segmented.jsx';

const SPARE_BLACK = ['bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];
const SPARE_WHITE = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK'];

export default function BoardArea({ explorer }) {
    const { fen, actions } = explorer;
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';

    return (
        <div className="board-group">
            <Segmented
                className="turn-row" itemClassName="turn-btn" label="Side to move"
                value={turn} onChange={actions.setTurn}
                options={[
                    { value: 'w', id: 'turn-white', title: 'White to move', content: <><span className="turn-pip turn-pip--w" aria-hidden="true"></span>White to move</> },
                    { value: 'b', id: 'turn-black', title: 'Black to move', content: <><span className="turn-pip turn-pip--b" aria-hidden="true"></span>Black to move</> },
                ]}
            />
            <div className="board-wrap" aria-label="Chess board">
                <div id="board-wrap-inner" className="board-wrap-inner">
                    <div className="spare-tray spare-tray--black" data-color="b">
                        {SPARE_BLACK.map(code => (
                            <button key={code} className="spare-piece" data-piece={code} type="button">
                                <img src="" draggable="false" alt="" />
                            </button>
                        ))}
                    </div>
                    <div id="board"></div>
                    <div className="spare-tray spare-tray--white" data-color="w">
                        {SPARE_WHITE.map(code => (
                            <button key={code} className="spare-piece" data-piece={code} type="button">
                                <img src="" draggable="false" alt="" />
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
