// Modelo de lenguaje de n-gramas: P(palabra | últimas n-1 palabras).
// Mezcla los órdenes 1..n; si un contexto largo no se vio, se apoya en los más cortos.

const INICIO = "<s>";
const DESCUENTO = 0.75;
const SEP = "\u0001";
const CLAVES = new Set(("select from where insert into values delete update set join inner on and or not null " +
  "create table primary key foreign references int varchar decimal date as group by order limit like in").split(" "));
// Palabra | cadena (quizá sin cerrar) | número | símbolo. Los comentarios "-- ..." se saltan.
const TOKEN_RE = /--[^\n]*|('(?:[^']|'')*'?)|(\d+(?:\.\d+)?)|([\p{L}_][\p{L}\p{N}_]*)|(<=|>=|<>|!=|[(),;.=*<>+\-/%])/gu;

function tokenizar(texto) {
  return [...texto.matchAll(TOKEN_RE)].filter(m => !m[0].startsWith("--")).map(m => ({
    raw: m[0], norm: m[3] ? m[0].toLowerCase() : m[0], palabra: !!m[3],
    ini: m.index, fin: m.index + m[0].length,
    abierto: !!m[1] && !(m[0].length > 1 && m[0].endsWith("'")),   // cadena sin cerrar
  }));
}

// Une palabras con espaciado SQL: "c" + "." + "nombre" -> "c.nombre"
function pegar(base, palabras) {
  for (const w of palabras) {
    const pegado = /^[,;).]$/.test(w);
    if (pegado) base = base.trimEnd();
    base += (pegado || !base || /[\s(.]$/.test(base) ? "" : " ") + w;
  }
  return base;
}

class ModeloNGramas {
  constructor(texto, n = 4) {
    this.n = n;
    this.tablas = Array.from({ length: n + 1 }, () => new Map());   // tablas[k]: contexto -> {palabras, total}
    const vocab = new Set();
    let sentencia = [];
    for (const t of tokenizar(texto)) {
      vocab.add(t.norm);
      sentencia.push(t.norm);
      if (t.norm === ";") { this.contar(sentencia); sentencia = []; }
    }
    this.contar(sentencia);
    this.vocab = [...vocab];
  }

  contar(sentencia) {
    const seq = Array(this.n - 1).fill(INICIO).concat(sentencia);
    for (let i = this.n - 1; i < seq.length; i++) {
      for (let k = 1; k <= this.n; k++) {
        const clave = seq.slice(i - k + 1, i).join(SEP);
        const e = this.tablas[k].get(clave) ?? { palabras: new Map(), total: 0 };
        this.tablas[k].set(clave, e);
        e.palabras.set(seq[i], (e.palabras.get(seq[i]) ?? 0) + 1);
        e.total++;
      }
    }
  }

  // Probabilidad de cada palabra del vocabulario dado el contexto (suman 1)
  distribucion(contexto) {
    const ctx = Array(this.n - 1).fill(INICIO).concat(contexto);
    let dist = new Map(this.vocab.map(w => [w, 1 / (this.vocab.length + 1)]));
    for (let k = 1; k <= this.n; k++) {
      const e = this.tablas[k].get(ctx.slice(ctx.length - k + 1).join(SEP));
      if (!e) continue;                                  // contexto nunca visto: usa el orden menor
      const lambda = DESCUENTO * e.palabras.size / e.total;
      dist = new Map([...dist].map(([w, p]) => [w, lambda * p + Math.max((e.palabras.get(w) ?? 0) - DESCUENTO, 0) / e.total]));
    }
    return dist;
  }

  // Lo escrito se divide en: contexto, palabra a medias, texto anterior a ella y estilo de mayúsculas
  analizar(texto) {
    const toks = tokenizar(texto);
    const ult = toks.at(-1);
    const medias = ult && ult.fin === texto.length && (ult.palabra || /^\d/.test(ult.raw) || ult.abierto) ? ult : null;
    const previos = medias ? toks.slice(0, -1) : toks;
    const contexto = [];
    for (const t of previos) t.norm === ";" ? (contexto.length = 0) : contexto.push(t.norm);
    const ultClave = previos.findLast(t => CLAVES.has(t.norm));
    const mayus = ultClave ? ultClave.raw === ultClave.raw.toUpperCase()
      : !(medias?.palabra && medias.raw === medias.raw.toLowerCase());
    return { contexto, prefijo: medias ? medias.norm.toLowerCase() : "", mayus,
             base: medias ? texto.slice(0, medias.ini) : texto };
  }

  // Candidatas ordenadas por probabilidad, ya filtradas por lo que se está escribiendo
  candidatas(contexto, prefijo) {
    return [...this.distribucion(contexto)]
      .filter(([w]) => w !== INICIO && w.toLowerCase().startsWith(prefijo)).sort((a, b) => b[1] - a[1]);
  }

  sugerir(texto, cuantas = 6) {
    const { contexto, prefijo, mayus, base } = this.analizar(texto);
    const cand = this.candidatas(contexto, prefijo);
    const suma = cand.reduce((s, [, p]) => s + p, 0) || 1;
    return cand.slice(0, cuantas).map(([w, p]) => {
      const mostrado = mayus && CLAVES.has(w) ? w.toUpperCase() : w;
      const final = w === ";" ? "\n" : /^[(.]$/.test(w) ? "" : " ";
      return { palabra: mostrado, prob: p / suma, texto: pegar(base, [mostrado]) + final };
    });
  }

  // Continúa el texto eligiendo cada palabra al azar según su probabilidad (hasta el ';')
  generar(texto, maxPalabras = 40) {
    const { contexto, prefijo, mayus, base } = this.analizar(texto);
    const salida = [];
    for (let i = 0; i < maxPalabras; i++) {
      const cand = this.candidatas(contexto, i ? "" : prefijo);
      if (!cand.length) break;
      let r = Math.random() * cand.reduce((s, [, p]) => s + p, 0);
      const [w] = cand.find(([, p]) => (r -= p) <= 0) ?? cand[0];
      salida.push(mayus && CLAVES.has(w) ? w.toUpperCase() : w);
      contexto.push(w);
      if (w === ";") break;
    }
    return pegar(base, salida);
  }
}
