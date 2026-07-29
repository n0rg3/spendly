import { useState, useCallback, useEffect, useRef } from "react";
import { Check, Delete } from "lucide-react";

type CalculatorKeyboardProps = {
  value: number;
  onChange: (value: number) => void;
  onClose: () => void;
};

const OPERATORS = ["+", "-", "*", "/"];

function evaluate(expression: string): number {
  try {
    const result = Function(`"use strict"; return (${expression})`)();
    if (typeof result === "number" && isFinite(result)) {
      return Math.round(result);
    }
    return NaN;
  } catch {
    return NaN;
  }
}

export default function CalculatorKeyboard({ value, onChange, onClose }: CalculatorKeyboardProps) {
  const [expression, setExpression] = useState(value > 0 ? String(value) : "");
  const [result, setResult] = useState<number | null>(value > 0 ? value : null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleNumber = useCallback((num: string) => {
    setExpression((prev) => {
      if (result !== null) {
        setResult(null);
        return num;
      }
      return prev + num;
    });
    setResult(null);
  }, [result]);

  const handleOperator = useCallback((op: string) => {
    setExpression((prev) => {
      if (prev === "" || prev === "0") return prev;
      const lastChar = prev.slice(-1);
      if (OPERATORS.includes(lastChar)) {
        return prev.slice(0, -1) + op;
      }
      return prev + op;
    });
    setResult(null);
  }, []);

  const handleBackspace = useCallback(() => {
    setExpression((prev) => {
      if (result !== null) {
        setResult(null);
        return "";
      }
      return prev.slice(0, -1);
    });
  }, [result]);

  const handleEquals = useCallback(() => {
    if (!expression) return;
    const calculated = evaluate(expression);
    if (!isNaN(calculated)) {
      setResult(calculated);
      setExpression(String(calculated));
      onChange(calculated);
    }
  }, [expression, onChange]);

  const handleSubmit = useCallback(() => {
    if (result !== null) {
      onChange(result);
    } else if (expression) {
      const calculated = evaluate(expression);
      if (!isNaN(calculated)) {
        onChange(calculated);
      }
    }
    onClose();
  }, [expression, result, onChange, onClose]);

  const displayValue = expression || "0";

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const key = e.key;
    if (key >= "0" && key <= "9") {
      handleNumber(key);
    } else if (key === "Backspace") {
      handleBackspace();
    } else if (key === "Enter" || key === "=") {
      handleEquals();
    } else if (key === "Escape") {
      onClose();
    } else if (key === "+") {
      handleOperator("+");
    } else if (key === "-") {
      handleOperator("-");
    } else if (key === "*") {
      handleOperator("*");
    } else if (key === "/") {
      handleOperator("/");
    }
  }, [handleNumber, handleBackspace, handleEquals, handleOperator, onClose]);

  return (
    <div className="calc-keyboard-overlay" onClick={onClose}>
      <div className="calc-keyboard" onClick={(e) => e.stopPropagation()}>
        {/* Дисплей */}
        <div className="calc-display">
          <input
            ref={inputRef}
            className="calc-display-input"
            value={displayValue}
            onChange={(e) => {
              const val = e.target.value;
              if (/^[\d+\-*/.]*$/.test(val) || val === "") {
                setExpression(val);
                setResult(null);
              }
            }}
            onKeyDown={handleKeyDown}
            inputMode="none"
            autoFocus
          />
          {result !== null && (
            <div className="calc-result">
              = {result.toLocaleString("ru-RU")} ₽
            </div>
          )}
        </div>

        {/* Клавиатура: 4 колонки × 4 ряда */}
        <div className="calc-grid">
          {/* Ряд 1 */}
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("1")}>1</button>
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("2")}>2</button>
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("3")}>3</button>
          <button className="calc-btn calc-btn-op" onClick={() => handleOperator("+")}>+</button>

          {/* Ряд 2 */}
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("4")}>4</button>
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("5")}>5</button>
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("6")}>6</button>
          <button className="calc-btn calc-btn-op" onClick={() => handleOperator("-")}>−</button>

          {/* Ряд 3 */}
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("7")}>7</button>
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("8")}>8</button>
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("9")}>9</button>
          <button className="calc-btn calc-btn-op" onClick={() => handleOperator("*")}>×</button>

          {/* Ряд 4 */}
          <button className="calc-btn calc-btn-func" onClick={handleBackspace} aria-label="Стереть">
            <Delete size={26} strokeWidth={2} />
          </button>
          <button className="calc-btn calc-btn-num" onClick={() => handleNumber("0")}>0</button>
          <button className="calc-btn calc-btn-submit" onClick={handleSubmit} aria-label="Принять">
            <Check size={28} strokeWidth={2.5} />
          </button>
          <button className="calc-btn calc-btn-equals" onClick={handleEquals}>=</button>
        </div>
      </div>
    </div>
  );
}