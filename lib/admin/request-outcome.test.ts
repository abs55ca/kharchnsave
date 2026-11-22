import { describe, expect, it } from "vitest";
import { afterAnswer, answerForDbError, blockedMessage, outcomeOf } from "./request-outcome";

describe("admin form request outcomes", () => {
  it("classify answers", () => {
    expect(outcomeOf({ done: true })).toBe("done");
    expect(outcomeOf({})).toBe("refused");
    expect(outcomeOf({ uncertain: true })).toBe("uncertain");
    expect(outcomeOf({ blocked: "signed_out" })).toBe("blocked");
  });

  it("only a definitive outcome resolves an unconfirmed request", () => {
    // The reproduction: unconfirmed, then the retry is refused because the session expired.
    expect(afterAnswer("blocked", true)).toEqual({ keepUnconfirmed: true, newRequestId: false });
    expect(afterAnswer("uncertain", true)).toEqual({ keepUnconfirmed: true, newRequestId: false });
    expect(afterAnswer("done", true)).toEqual({ keepUnconfirmed: false, newRequestId: true });
    expect(afterAnswer("refused", true)).toEqual({ keepUnconfirmed: false, newRequestId: true });
  });

  it("a new request: refused input can be corrected; blocked or uncertain keeps its id", () => {
    expect(afterAnswer("refused", false)).toEqual({ keepUnconfirmed: false, newRequestId: true });
    expect(afterAnswer("blocked", false)).toEqual({ keepUnconfirmed: false, newRequestId: false });
    expect(afterAnswer("uncertain", false)).toEqual({ keepUnconfirmed: true, newRequestId: false });
  });

  it("database errors: no answer is uncertain; access and lock errors block; the rest are refusals", () => {
    expect(answerForDbError({ code: "", message: "TypeError: fetch failed" })).toEqual({ uncertain: true });
    expect(answerForDbError(null)).toEqual({ uncertain: true });
    expect(answerForDbError({ code: "42501" })).toEqual({ blocked: "no_access" });
    for (const code of ["55P03", "40P01", "40001"]) expect(answerForDbError({ code })).toEqual({ blocked: "busy" });
    expect(answerForDbError({ code: "PT409" })).toEqual({});
    expect(answerForDbError({ code: "PT400" })).toEqual({});
  });

  it("messages: sign in elsewhere and retry the unconfirmed save, never re-enter it", () => {
    expect(blockedMessage("signed_out", true)).toMatch(/still unconfirmed.*Sign in again.*Retry unconfirmed save.*Don’t enter the change again/);
    expect(blockedMessage("signed_out", false)).toMatch(/nothing was saved/);
  });
});
