import { Chess } from "chess.js";
import { LESSONS } from "../../client/src/learn/curriculum.js";

let bad = 0;
const fail = (l: string, i: number, msg: string) => { bad++; console.log(`FAIL ${l} step ${i + 1}: ${msg}`); };
for (const L of LESSONS) {
  L.steps.forEach((s, i) => {
    const fen = "fen" in s ? s.fen : undefined;
    let c: Chess | null = null;
    if (fen) { try { c = new Chess(fen); } catch (e: any) { return fail(L.key, i, `invalid FEN ${fen}: ${e.message}`); } }
    if (s.t === "move") {
      const moves = c!.moves({ verbose: true });
      const ok = (m: any) => {
        if (s.from && m.from !== s.from) return false;
        const uci = m.from + m.to + (m.promotion ?? "");
        if (s.uci) return s.uci.includes(m.from + m.to) || s.uci.includes(uci);
        if (s.to) return s.to.includes(m.to);
        if (s.any) return true;
        const t = new Chess(fen); t.move(m);
        if (s.mate) return t.isCheckmate();
        if (s.check) return t.inCheck();
        return false;
      };
      const good = moves.filter(ok);
      if (!good.length) fail(L.key, i, `no legal solution in ${fen}`);
      else if (s.uci) for (const u of s.uci) if (!moves.some((m) => m.from + m.to === u)) fail(L.key, i, `listed move ${u} is not legal`);
      const wrong = Object.keys(s.wrong ?? {}).filter((sq) => !moves.some((m) => m.to === sq));
      if (wrong.length) console.log(`  note ${L.key} step ${i + 1}: 'wrong' squares not reachable: ${wrong.join(",")}`);
      if (s.t === "move" && s.marks) for (const m of s.marks) if (!/^[a-h][1-8]$/.test(m)) fail(L.key, i, `bad mark ${m}`);
      if (c!.inCheck() && !s.any) fail(L.key, i, "side to move starts in check");
    }
    if (s.t === "quiz" && (s.answer < 0 || s.answer >= s.options.length)) fail(L.key, i, "answer index out of range");
    if (s.t === "info" && s.fen && s.fen.split(" ")[1] === "b" && L.key !== "mate" && L.key !== "special") console.log(`  note ${L.key} step ${i + 1}: black to move display`);
  });
  console.log(`${L.key}: ${L.steps.length} steps checked`);
}
console.log(bad ? `${bad} problem(s)` : "curriculum OK");
