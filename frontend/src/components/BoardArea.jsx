import { memo } from 'react';
import Segmented from './ui/Segmented.jsx';

const PIECE_LETTERS = ['P', 'N', 'B', 'R', 'Q', 'K'];

const TURN_OPTIONS = [
    { value: 'w', id: 'turn-white', title: 'White to move', content: <><span className="turn-pip turn-pip--w" aria-hidden="true"></span>White to move</> },
    { value: 'b', id: 'turn-black', title: 'Black to move', content: <><span className="turn-pip turn-pip--b" aria-hidden="true"></span>Black to move</> },
];

// board.js attaches the interaction handlers and sets each image src for the
// active piece set.
function SpareTray({ color }) {
    return (
        <div className={`spare-tray spare-tray--${color === 'b' ? 'black' : 'white'}`} data-color={color}>
            {PIECE_LETTERS.map(letter => {
                const code = color + letter;
                return (
                    <button key={code} className="spare-piece" data-piece={code} type="button">
                        <img src="" draggable="false" alt="" />
                    </button>
                );
            })}
        </div>
    );
}

function BoardArea({ turn, onTurnChange }) {
    return (
        <div className="board-group">
            <Segmented
                className="turn-row" itemClassName="turn-btn" label="Side to move"
                value={turn} onChange={onTurnChange} options={TURN_OPTIONS}
            />
            <div className="board-wrap" aria-label="Chess board">
                <div id="board-wrap-inner" className="board-wrap-inner">
                    <SpareTray color="b" />
                    <div id="board"></div>
                    <SpareTray color="w" />
                </div>
            </div>
        </div>
    );
}

export default memo(BoardArea);
