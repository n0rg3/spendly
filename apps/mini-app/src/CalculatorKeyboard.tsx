import { Check, Delete } from "lucide-react";

type CalculatorKeyboardProps = {
  onInput: (char: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
};

export default function CalculatorKeyboard({ onInput, onBackspace, onSubmit }: CalculatorKeyboardProps) {
  return (
    <div className="calc-keyboard-panel" onClick={(e) => e.stopPropagation()}>
      <div className="calc-grid">
        {/* Ряд 1 */}
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("1")}>1</button>
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("2")}>2</button>
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("3")}>3</button>
        <button type="button" className="calc-btn calc-btn-op" onClick={() => onInput("+")}>+</button>

        {/* Ряд 2 */}
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("4")}>4</button>
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("5")}>5</button>
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("6")}>6</button>
        <button type="button" className="calc-btn calc-btn-op" onClick={() => onInput("-")}>−</button>

        {/* Ряд 3 */}
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("7")}>7</button>
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("8")}>8</button>
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("9")}>9</button>
        <button type="button" className="calc-btn calc-btn-op" onClick={() => onInput("*")}>×</button>

        {/* Ряд 4 */}
        <button type="button" className="calc-btn calc-btn-func" onClick={onBackspace} aria-label="Стереть">
          <Delete size={24} strokeWidth={2} />
        </button>
        <button type="button" className="calc-btn calc-btn-num" onClick={() => onInput("0")}>0</button>
        <button type="button" className="calc-btn calc-btn-submit" onClick={onSubmit} aria-label="Принять">
          <Check size={28} strokeWidth={2.5} />
        </button>
        <button type="button" className="calc-btn calc-btn-op" onClick={() => onInput("/")}>÷</button>
      </div>
    </div>
  );
}