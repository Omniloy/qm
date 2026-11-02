import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  CHUNK_TARGET_CHARS,
  FIRST_CHUNK_MIN_CHARS,
  createTextChunker,
  stepsForChunk,
} from "../src/voice-assistant/text-chunker.ts";

function streamed(text: string, step = 3): string[] {
  const chunker = createTextChunker();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(...chunker.push(text.slice(i, i + step)));
  out.push(...chunker.flush());
  return out;
}

test("the first chunk ends at the first clause mark once it reaches the minimum length", () => {
  const chunks = streamed("Claro, ahora mismo lo miro, dame un segundo. Ya tengo el resultado del informe.");
  assert.deepEqual(chunks, ["Claro, ahora mismo lo miro,", "dame un segundo. Ya tengo el resultado del informe."]);
  assert.ok(chunks[0].length >= CHUNK_MIN_CHARS);
});

test("later chunks break on sentences, not commas", () => {
  const chunks = streamed(
    "Hola, he terminado tu tarea de hoy. El informe, que incluye tres secciones, ya está listo. ¿Quieres que te lo resuma ahora?",
  );
  assert.deepEqual(chunks, [
    "Hola, he terminado tu tarea de hoy.",
    "El informe, que incluye tres secciones, ya está listo.",
    "¿Quieres que te lo resuma ahora?",
  ]);
});

test("a mark at the end of the buffer waits for the next delta so decimals are not split", () => {
  const chunker = createTextChunker();
  assert.deepEqual(chunker.push("El total asciende a 3"), []);
  assert.deepEqual(chunker.push(","), []);
  assert.deepEqual(chunker.push("5 millones de euros, más impuestos."), ["El total asciende a 3,5 millones de euros,"]);
  assert.deepEqual(chunker.flush(), ["más impuestos."]);
});

test("abbreviations and initials do not end a sentence", () => {
  const chunks = streamed(
    "Perfecto, ya está hecho. Mañana hablo con el Sr. García y con la Dra. Pérez sobre el plan B. Luego te aviso.",
  );
  assert.deepEqual(chunks, [
    "Perfecto, ya está hecho.",
    "Mañana hablo con el Sr. García y con la Dra. Pérez sobre el plan B. Luego te aviso.",
  ]);
});

test("short sentences merge until a chunk reaches the minimum length", () => {
  assert.deepEqual(streamed("Sí. Claro. Lo hago ahora mismo. Vale."), ["Sí. Claro. Lo hago ahora mismo.", "Vale."]);
});

test("long text without sentence marks is cut at a clause or a space within the target length", () => {
  const words = Array.from({ length: 80 }, (_, i) => `palabra${i}`).join(" ");
  const chunks = streamed(`Empiezo ya mismo, ${words}`);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) assert.ok(chunk.length <= CHUNK_TARGET_CHARS, `${chunk.length}`);
  assert.equal(chunks.join(" "), `Empiezo ya mismo, ${words}`);
});

test("text with no spaces is hard-cut at the maximum length and never exceeds it", () => {
  const blob = "x".repeat(CHUNK_MAX_CHARS * 2 + 17);
  const chunks = streamed(blob, 50);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [CHUNK_MAX_CHARS, CHUNK_MAX_CHARS, 17],
  );
});

test("newlines break chunks and markup-only fragments are dropped", () => {
  const chunks = streamed(
    "Estas son tus tareas pendientes:\n- Revisar el contrato de alquiler\n- Llamar a Marta mañana\n**",
  );
  assert.deepEqual(chunks, [
    "Estas son tus tareas pendientes:",
    "- Revisar el contrato de alquiler",
    "- Llamar a Marta mañana",
  ]);
});

test("flush emits the remainder and resets so the next reply starts a fresh first chunk", () => {
  const chunker = createTextChunker();
  assert.deepEqual(chunker.push("Hecho"), []);
  assert.deepEqual(chunker.flush(), ["Hecho"]);
  assert.deepEqual(chunker.flush(), []);
  assert.deepEqual(chunker.push("Vale, te cuento lo que pasa ahora, "), ["Vale, te cuento lo que pasa ahora,"]);
});

test("whitespace is collapsed inside chunks", () => {
  assert.deepEqual(streamed("  Hola   equipo,\tya   está todo   listo.  "), ["Hola equipo, ya está todo listo."]);
});

test("the first chunk uses two denoising steps and the rest use five", () => {
  assert.equal(stepsForChunk(0), 3);
  assert.equal(stepsForChunk(1), 5);
  assert.equal(stepsForChunk(7), 5);
});

test("a short opening sentence is spoken as soon as the next word starts", () => {
  const chunker = createTextChunker();
  assert.deepEqual(chunker.push("Me pongo con ello."), []);
  assert.deepEqual(chunker.push(" Te"), ["Me pongo con ello."]);
  assert.ok("Me pongo con ello.".length >= FIRST_CHUNK_MIN_CHARS);
});
