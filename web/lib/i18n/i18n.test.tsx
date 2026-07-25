import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LangProvider, useI18n, modeLabel, warnLabel, flagLabel } from "./index";
import { DICTS } from "./dict";

function Probe() {
  const { lang, dict, setLang } = useI18n();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="h1">{dict.h1}</span>
      <button onClick={() => setLang("en")}>to-en</button>
      <button onClick={() => setLang("ru")}>to-ru</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("LangProvider", () => {
  it("starts in uk when nothing is saved in localStorage", () => {
    render(
      <LangProvider>
        <Probe />
      </LangProvider>
    );

    expect(screen.getByTestId("lang")).toHaveTextContent("uk");
    expect(screen.getByTestId("h1")).toHaveTextContent(DICTS.uk.h1);
  });

  it("picks up a saved language from localStorage after mount", () => {
    localStorage.setItem("lang", "ru");

    render(
      <LangProvider>
        <Probe />
      </LangProvider>
    );

    expect(screen.getByTestId("lang")).toHaveTextContent("ru");
    expect(screen.getByTestId("h1")).toHaveTextContent(DICTS.ru.h1);
  });

  it("ignores an invalid saved language and stays on uk", () => {
    localStorage.setItem("lang", "xx");

    render(
      <LangProvider>
        <Probe />
      </LangProvider>
    );

    expect(screen.getByTestId("lang")).toHaveTextContent("uk");
  });

  it("switching language re-renders with the new dict and persists the choice", async () => {
    const user = userEvent.setup();
    render(
      <LangProvider>
        <Probe />
      </LangProvider>
    );

    await user.click(screen.getByText("to-en"));

    expect(screen.getByTestId("lang")).toHaveTextContent("en");
    expect(screen.getByTestId("h1")).toHaveTextContent(DICTS.en.h1);
    expect(localStorage.getItem("lang")).toBe("en");
  });

  it("keeps document.documentElement.lang in sync with the active language", async () => {
    const user = userEvent.setup();
    render(
      <LangProvider>
        <Probe />
      </LangProvider>
    );

    expect(document.documentElement.lang).toBe("uk");

    await user.click(screen.getByText("to-ru"));

    expect(document.documentElement.lang).toBe("ru");
  });
});

describe("modeLabel / warnLabel / flagLabel", () => {
  it("modeLabel resolves a known mode to its translated label", () => {
    expect(modeLabel(DICTS.uk, "Battery")).toBe(DICTS.uk.modeBattery);
  });

  it("modeLabel falls back to the raw mode string when unknown", () => {
    expect(modeLabel(DICTS.uk, "Unknown123")).toBe("Unknown123");
  });

  it("warnLabel resolves a known warning name to its translation", () => {
    expect(warnLabel(DICTS.uk, "Overload")).toBe(DICTS.uk.warnings["Overload"]);
  });

  it("warnLabel falls back to the raw name when not present in the dict (e.g. en)", () => {
    expect(warnLabel(DICTS.en, "Overload")).toBe("Overload");
  });

  it("flagLabel resolves a known flag key", () => {
    expect(flagLabel(DICTS.uk, "ecoMode")).toBe(DICTS.uk.flags.ecoMode);
  });

  it("flagLabel falls back with the flagFallback prefix when no fallback is given", () => {
    expect(flagLabel(DICTS.uk, "unknownFlag")).toBe(DICTS.uk.flagFallback + "unknownFlag");
  });

  it("flagLabel uses an explicit fallback when provided and the key is missing", () => {
    expect(flagLabel(DICTS.uk, "unknownFlag", "Custom")).toBe("Custom");
  });
});

/** Собирает все пути ключей объекта рекурсивно, напр. { a: { b: 1 } } -> ["a.b"]. */
function collectKeyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    paths.push(...collectKeyPaths(value, prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

describe("dictionary key parity (uk/ru/en)", () => {
  it("uk/ru/en expose the same set of keys, except the intentionally-empty en.warnings", () => {
    // dict.ts типизирует ru/en как `Dict = typeof uk`, что гарантирует структурное
    // совпадение на уровне TS для всех полей, КРОМЕ содержимого `warnings`
    // (typed as Record<string,string> — index signature, TS не требует конкретных
    // ключей). Проверяем это же инвариантом в рантайме, отдельно от warnings.
    const withoutWarnings = (paths: string[]) => paths.filter((p) => !p.startsWith("warnings."));

    const ukKeys = withoutWarnings(collectKeyPaths(DICTS.uk)).sort();
    const ruKeys = withoutWarnings(collectKeyPaths(DICTS.ru)).sort();
    const enKeys = withoutWarnings(collectKeyPaths(DICTS.en)).sort();

    expect(ukKeys.length).toBeGreaterThan(0);
    expect(ruKeys).toEqual(ukKeys);
    expect(enKeys).toEqual(ukKeys);
  });

  it("uk and ru fully translate the same set of fault/warning bit names", () => {
    const ukWarnKeys = Object.keys(DICTS.uk.warnings).sort();
    const ruWarnKeys = Object.keys(DICTS.ru.warnings).sort();

    expect(ukWarnKeys.length).toBeGreaterThan(0);
    expect(ruWarnKeys).toEqual(ukWarnKeys);
  });

  it("en.warnings is intentionally empty (English UI falls back to the raw bit name via warnLabel)", () => {
    // Ключи warnings — это исходные английские строки из smg.ts; для en-локали
    // переводить нечего, warnLabel() отдаёт сам ключ как есть.
    expect(Object.keys(DICTS.en.warnings)).toEqual([]);
  });
});
