// Frasco de decant animado (repo althamir-bot). Reemplaza a un .patch.
//  - Se quita el interruptor "Sin tapa / Con tapa".
//  - Queda una sola animación en bucle: el frasco se destapa (la tapa sube), da un spray (una nube fina sale del orificio
//    de los dos frascos) y se vuelve a tapar; luego reposa un momento y empieza de nuevo (ciclo de 9.5 s).
//  - Con "movimiento reducido" activado en el equipo, o si el equipo no da la talla, el frasco se queda tapado y quieto.
//  - La cámara queda fija con más espacio arriba para que la tapa levantada no se corte.
// Uso, desde la carpeta del repo althamir-bot:
//   node aplicar-frasco-animado.mjs --probar    (solo revisa, no cambia nada)
//   node aplicar-frasco-animado.mjs             (aplica los cambios)
// Respeta tus cambios locales y los saltos de línea de Windows. Si algún trozo de tu archivo es
// distinto, no toca NADA y te dice cuál es.
import fs from "node:fs";
import path from "node:path";

const PROBAR = process.argv.includes("--probar");

function leer(f) {
  const raw = fs.readFileSync(f, "utf8");
  return { txt: raw.replace(/\r\n/g, "\n"), crlf: raw.includes("\r\n") };
}
function aplicarPares(txt, pares) {
  const malos = [];
  let aplicados = 0, ya = 0;
  pares.forEach(([o, n], i) => {
    const veces = txt.split(o).length - 1;
    if (!o.includes(n) && txt.includes(n)) { ya++; return; }          // ya estaba aplicado
    if (veces === 1) { txt = txt.replace(o, () => n); aplicados++; return; }
    if (o.includes(n) && veces === 0 && txt.includes(n)) { ya++; return; } // borrado ya hecho
    const donde = o.split("\n").reduce((a, l) => (l.trim().length > a.trim().length ? l : a), "");
    malos.push(`cambio ${i + 1}: ${veces === 0 ? "no encontré el texto original (esa zona de tu archivo es distinta)" : "el texto aparece " + veces + " veces"} → «${donde.trim().slice(0, 80)}»`);
  });
  return { txt, aplicados, ya, malos };
}

const ARCHIVOS = {
 "index.html": [
  [
   ".decant-text{font-size:15px;line-height:1.9;color:var(--text-dim);max-width:460px}\n.decant-sizes{display:flex;gap:12px;margin:24px 0 14px;max-width:460px}\n.decant-tapa{display:flex;gap:10px;margin:0 0 26px;max-width:460px}\n.decant-tapa-btn{padding:7px 15px;border:1px solid var(--gold-border);border-radius:30px;background:transparent;color:var(--text-dim);font-family:inherit;font-size:11px;letter-spacing:1.5px;cursor:pointer;transition:border-color .25s,background .25s,color .25s}\n.decant-tapa-btn.active{border-color:var(--gold);color:var(--text);background:var(--gold-dim)}\n.decant-sin3d .decant-tapa{display:none}\n.decant-size{flex:1;padding:14px 10px;background:transparent;border:1px solid var(--gold-border);color:var(--text);font-family:inherit;cursor:pointer;text-align:center;transition:border-color .25s,background .25s}",
   ".decant-text{font-size:15px;line-height:1.9;color:var(--text-dim);max-width:460px}\n.decant-sizes{display:flex;gap:12px;margin:24px 0 26px;max-width:460px}\n.decant-size{flex:1;padding:14px 10px;background:transparent;border:1px solid var(--gold-border);color:var(--text);font-family:inherit;cursor:pointer;text-align:center;transition:border-color .25s,background .25s}"
  ],
  [
   "  .decant-info{text-align:center}\n  .decant-text,.decant-sizes,.decant-tonos,.decant-tapa{margin-left:auto;margin-right:auto}\n  .decant-tonos,.decant-sizes,.decant-tapa{justify-content:center}\n}",
   "  .decant-info{text-align:center}\n  .decant-text,.decant-sizes,.decant-tonos{margin-left:auto;margin-right:auto}\n  .decant-tonos,.decant-sizes{justify-content:center}\n}"
  ],
  [
   "        <button type=\"button\" class=\"decant-size\" data-size=\"1\" aria-pressed=\"false\"><b>10 ml</b><span id=\"decantP10\">para llevar siempre</span></button>\n      </div>\n      <div class=\"decant-tapa\" role=\"group\" aria-label=\"Vista del frasco\">\n        <button type=\"button\" class=\"decant-tapa-btn active\" data-cap=\"0\" aria-pressed=\"true\">Sin tapa</button>\n        <button type=\"button\" class=\"decant-tapa-btn\" data-cap=\"1\" aria-pressed=\"false\">Con tapa</button>\n      </div>",
   "        <button type=\"button\" class=\"decant-size\" data-size=\"1\" aria-pressed=\"false\"><b>10 ml</b><span id=\"decantP10\">para llevar siempre</span></button>\n      </div>"
  ],
  [
   "\n  var E = { size: 0, cap: 0, fill: reducir ? 1 : 0, rot: 0.6, vel: AUTO, elev: 0.12, col: rgb('0.72,0.38,0.07') };   // lo que se ve\n  var OBJ = { size: 0, cap: 0, fill: 0, col: rgb('0.72,0.38,0.07') };                                               // a donde va\n  var elevObj = 0.12, rotScroll = 0, arrastrando = false;",
   "\n  var E = { size: 0, cap: 1, spray: 0, giro: 0, fill: reducir ? 1 : 0, rot: 0.6, vel: AUTO, elev: 0.12, col: rgb('0.72,0.38,0.07') };   // lo que se ve (cap: 1 = tapado)\n  var OBJ = { size: 0, cap: 1, fill: 0, col: rgb('0.72,0.38,0.07') };                                               // a donde va\n  var elevObj = 0.12, rotScroll = 0, arrastrando = false;"
  ],
  [
   "  function kick(ms) { kickHasta = performance.now() + ms; ajustar(); }\n",
   "  function kick(ms) { kickHasta = performance.now() + ms; ajustar(); }\n\n  // CICLO (loop): tapado → la tapa sube → rocía una nube fina → la tapa baja → reposo → vuelve a empezar.\n  // En \"movimiento reducido\" o si el equipo no da la talla se queda tapado y quieto.\n  var CICLO = 9.5, tc = 0, FI = 2.18;        // FI: hacia dónde mira el orificio mientras rocía (rad)\n  function ss01(a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }\n  function guion(s) {\n    return {\n      cap: 1 - 0.42 * ss01(0.9, 2.0, s) + 0.42 * ss01(4.8, 5.9, s),        // 1 = tapa puesta · 0.58 = tapa levantada\n      spray: Math.min(1, Math.max(0, (s - 2.5) / 1.9)),                    // 0 → 1 mientras sale la nube\n      giro: ss01(0.3, 1.5, s) * (1 - ss01(5.2, 6.3, s))                    // cuánto se orienta el frasco hacia el frente\n    };\n  }\n"
  ],
  [
   "      kick(2400);\n    });\n  });\n  var botonesTapa = sec.querySelectorAll('.decant-tapa-btn');\n  botonesTapa.forEach(function (b) {\n    b.addEventListener('click', function () {\n      botonesTapa.forEach(function (x) { var on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });\n      OBJ.cap = Number(b.getAttribute('data-cap'));\n      kick(2000);\n    });",
   "      kick(2400);\n    });"
  ],
  [
   "      '#endif',\n      'uniform vec2 uRes; uniform float uSel, uFill, uRot, uElev, uDist, uTy, uCap; uniform vec3 uLiq;',\n      'const float RG=.20, WALL=.022, BASE=.05;',",
   "      '#endif',\n      'uniform vec2 uRes; uniform float uSel, uFill, uRot, uElev, uDist, uTy, uCap, uSpray; uniform vec3 uLiq;',\n      'const float RG=.20, WALL=.022, BASE=.05;',"
  ],
  [
   "      '  return vec4(min(col,1.),clamp(al,0.,1.));}',\n      'void main(){',",
   "      '  return vec4(min(col,1.),clamp(al,0.,1.));}',\n      '// ----- spray: nube fina que sale del orificio de cada atomizador -----',\n      'vec4 mist(vec3 ro,vec3 rd,float cx,float Hg){',\n      '  if(uSpray<=.001)return vec4(0.);',\n      '  vec3 N=vec3(cx+.095*cos(uRot),Hg+.352,-.095*sin(uRot));',\n      '  vec3 D=normalize(vec3(cos(uRot),.12,-sin(uRot)));',\n      '  float L=.25+1.4*ss(0.,.55,uSpray);',\n      '  vec3 C=N+D*L*.5;float Rb=L*.62+.08;',\n      '  vec3 oc=ro-C;float b=dot(oc,rd),c=dot(oc,oc)-Rb*Rb;float h=b*b-c;',\n      '  if(h<0.)return vec4(0.);',\n      '  float sq=sqrt(h),ta=max(-b-sq,0.),tb=-b+sq;',\n      '  float dt=(tb-ta)/9.,acc=0.;',\n      '  for(int i=0;i<9;i++){',\n      '    vec3 p=ro+rd*(ta+dt*(float(i)+.5));vec3 q=p-N;',\n      '    float al=dot(q,D);',\n      '    if(al>0.&&al<L){',\n      '      vec3 lat=q-D*al;float rc=.012+.34*al;',\n      '      float core=ss(rc,0.,length(lat));',\n      '      float head=ss(L,L-.35,al),tail=ss(0.,.06,al);',\n      '      float n=.65+.35*sin(al*38.-uSpray*26.+atan(lat.y,lat.z+1e-4)*5.);',\n      '      acc+=core*head*tail*n*dt*5.5;}}',\n      '  float a=(1.-exp(-acc))*(1.-ss(.55,1.,uSpray))*.85;',\n      '  return vec4(mix(vec3(.96,.93,.86),uLiq*1.3+.35,.22)*a,a);}',\n      'void main(){',"
  ],
  [
   "      '  vec4 nr=v5,fr=v10;if(t10<t5){nr=v10;fr=v5;}',\n      '  gl_FragColor=vec4(min(nr.rgb+fr.rgb*(1.-nr.a),1.),nr.a+fr.a*(1.-nr.a));',\n      '}'",
   "      '  vec4 nr=v5,fr=v10;if(t10<t5){nr=v10;fr=v5;}',\n      '  vec4 bs=vec4(min(nr.rgb+fr.rgb*(1.-nr.a),1.),nr.a+fr.a*(1.-nr.a));',\n      '  vec4 m5=mist(ro,rd,-.42,H5),m10=mist(ro,rd,.42,H10);',\n      '  vec4 ms=vec4(m5.rgb+m10.rgb*(1.-m5.a),m5.a+m10.a*(1.-m5.a));',\n      '  gl_FragColor=vec4(min(ms.rgb+bs.rgb*(1.-ms.a),1.),min(bs.a+ms.a*(1.-bs.a),1.));',\n      '}'"
  ],
  [
   "    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);\n    var U = {}; ['uRes', 'uSel', 'uFill', 'uRot', 'uElev', 'uDist', 'uTy', 'uCap', 'uLiq'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });\n",
   "    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);\n    var U = {}; ['uRes', 'uSel', 'uFill', 'uRot', 'uElev', 'uDist', 'uTy', 'uCap', 'uSpray', 'uLiq'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });\n"
  ],
  [
   "      gl.uniform1f(U.uSel, E.size);   // 0 = 5 ml resaltado, 1 = 10 ml resaltado\n      var dist = 5.8 + 0.7 * E.cap;\n      gl.uniform1f(U.uDist, dist); gl.uniform1f(U.uTy, 1.45 + 0.17 * E.cap); gl.uniform1f(U.uCap, E.cap);\n      if (Math.abs(E.cap - capEtq) > 0.002) { capEtq = E.cap; ponerEtiquetas(dist); }\n      gl.uniform1f(U.uFill, E.fill);",
   "      gl.uniform1f(U.uSel, E.size);   // 0 = 5 ml resaltado, 1 = 10 ml resaltado\n      var dist = 7.3;      // cámara fija: con la tapa levantada el conjunto es más alto y debe seguir entrando\n      gl.uniform1f(U.uDist, dist); gl.uniform1f(U.uTy, 1.88); gl.uniform1f(U.uCap, E.cap); gl.uniform1f(U.uSpray, E.spray);\n      if (capEtq < 0) { capEtq = 0; ponerEtiquetas(dist); }\n      gl.uniform1f(U.uFill, E.fill);"
  ],
  [
   "      } else { E.size = OBJ.size; E.cap = OBJ.cap; E.fill = OBJ.fill; E.col = OBJ.col.slice(); E.elev = elevObj; }\n      if (!arrastrando) { E.rot += E.vel * s; E.vel += (AUTO - E.vel) * (1 - Math.exp(-s * 1.6)); }\n    }",
   "      } else { E.size = OBJ.size; E.cap = OBJ.cap; E.fill = OBJ.fill; E.col = OBJ.col.slice(); E.elev = elevObj; }\n      if (!reducir && continuo) {\n        tc += s;\n        var g = guion(tc % CICLO);\n        E.cap = g.cap; E.spray = g.spray; E.giro = g.giro;\n        if (!arrastrando && g.giro > 0.001) {      // el orificio gira hacia el frente mientras se destapa y rocía\n          var objRot = -FI - rotScroll, dif = Math.atan2(Math.sin(objRot - E.rot), Math.cos(objRot - E.rot));\n          E.rot += dif * (1 - Math.exp(-s * 4 * g.giro));\n        }\n      } else { E.giro = 0; E.spray = 0; }\n      if (!arrastrando) { E.rot += E.vel * s * (1 - E.giro); E.vel += (AUTO - E.vel) * (1 - Math.exp(-s * 1.6)); }\n    }"
  ]
 ]
};

for (const f of Object.keys(ARCHIVOS)) {
  if (!fs.existsSync(f)) { console.error(`✘ No encuentro ${f} aquí. Abre la terminal DENTRO de la carpeta del repo althamir-bot (y haz git pull antes).`); process.exit(1); }
}
const resultados = [];
let fallos = 0;
for (const [f, pares] of Object.entries(ARCHIVOS)) {
  const { txt, crlf } = leer(f);
  const r = aplicarPares(txt, pares);
  resultados.push({ f, crlf, ...r });
  console.log(`${r.malos.length ? "✘" : "✔"} ${f}: ${r.aplicados} cambios por aplicar, ${r.ya} ya estaban`);
  r.malos.forEach((m) => console.log("     " + m));
  fallos += r.malos.length;
}
if (fallos) { console.log(`\n✘ ${fallos} cambio(s) no se pudieron aplicar. No modifiqué ningún archivo. Mándame esta salida completa.`); process.exit(2); }
if (PROBAR) { console.log("\n(modo --probar) Todo se puede aplicar. No modifiqué nada."); process.exit(0); }
for (const r of resultados) if (r.aplicados) fs.writeFileSync(r.f, r.crlf ? r.txt.replace(/\n/g, "\r\n") : r.txt);
console.log("\n✔ Listo. Revisa con: git status   y   git diff");
