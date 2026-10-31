// Lista de disciplinas.
// Para adicionar uma matéria nova, acrescente UMA linha aqui. Nada mais precisa mudar.
//
// id   : identificador estável usado no Firestore e na URL (anki.html?materia=<id>).
//        Apenas letras minúsculas, números e "_" (2 a 40 caracteres). NUNCA altere
//        o id depois de ter cartões, pois ele define onde os dados ficam gravados.
// name : nome exibido na interface (pode ter acentos e espaços; pode mudar à vontade).
export const SUBJECTS = [
  { id: "tributario",     name: "Direito Tributário" },
  { id: "contabilidade",  name: "Contabilidade" },
  { id: "constitucional", name: "Direito Constitucional" },
  { id: "administrativo", name: "Direito Administrativo" },
  { id: "portugues",      name: "Língua Portuguesa" },
  { id: "raciocinio",     name: "Raciocínio Lógico" },
  { id: "legtributaria",  name: "Legislação Tributária" },
];

export const SUBJECT_ID_PATTERN = /^[a-z0-9_]{2,40}$/;

export function getSubject(id) {
  return SUBJECTS.find((s) => s.id === id) || null;
}

// Falha cedo se houver id inválido ou repetido (erro de digitação ao editar este arquivo).
export function assertSubjectsValid(list = SUBJECTS) {
  const seen = new Set();
  for (const s of list) {
    if (!SUBJECT_ID_PATTERN.test(s.id)) throw new Error(`Id de disciplina inválido: "${s.id}"`);
    if (seen.has(s.id)) throw new Error(`Id de disciplina repetido: "${s.id}"`);
    if (!s.name || typeof s.name !== "string") throw new Error(`Disciplina "${s.id}" sem nome`);
    seen.add(s.id);
  }
  return true;
}
