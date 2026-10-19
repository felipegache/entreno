# Formato de un capítulo

Un capítulo es un archivo `.json` con un programa de entrenamiento. La app lo valida al cargarlo. Puede venir suelto o envuelto como `{ "chapter": { ... } }` (así lo exporta la app).

```json
{
  "chapter": {
    "id": "fase2",
    "name": "Fase 2 · Base de fuerza y motor",
    "short": "Fase 2",
    "desc": "Intervalos 4×4, búlgara y más volumen de tren superior.",
    "weeks": 10,
    "rotation": ["L", "M", "V"],
    "days": { "L": 1, "M": 3, "V": 5 },
    "preMatch": "V",
    "postMatch": "L",
    "ramp": {
      "1": { "sets": 3, "setsArms": 3, "rirS": "3", "rirH": "1-2", "aero": 20, "soga": 8, "sombra": 4, "sprint": "85-90 %", "pogo": 12, "note": "Texto de la semana" },
      "5": { "sets": 2, "setsArms": 2, "rirS": "4", "rirH": "3", "aero": 15, "soga": 5, "sombra": 3, "sprint": "70-80 %", "pogo": 8, "note": "Descarga", "deload": true }
    },
    "sessions": {
      "L": { "name": "Lunes", "title": "Piernas y empuje", "items": [
        { "ex": "soga_rebote", "block": "Calentamiento y tobillo" },
        { "ex": "split_squat", "block": "Fuerza", "g": "A", "sets": "S" },
        { "ex": "flexiones", "block": "Fuerza", "g": "A", "sets": "S" },
        { "ex": "nordico", "block": "Fuerza", "sets": 2, "from": 3, "pre": "curl_toalla" }
      ] }
    },
    "exercises": {
      "intervalos_4x4": { "name": "Intervalos 4 × 4", "cat": "Aeróbico", "unit": "rondas", "work": 240, "rest": 180,
        "desc": "4 min duros (RPE 8-9) y 3 min suaves.", "cues": ["Solo palabras sueltas"], "errors": ["Arrancar a tope"], "q": "4x4 interval training" }
    }
  }
}
```

## Reglas

- `ramp` necesita una entrada por cada semana del 1 a `weeks`. Una semana con `"deload": true` se usa también para la descarga anticipada.
- `sets` en un ítem: `"S"` (series de la rampa), `"A"` (series de brazos de la rampa), `"SP"` (arranques: 4 o 6 según intensidad) o un número.
- `g` agrupa ítems consecutivos del mismo bloque en superserie.
- `from` hace que el ítem aparezca desde esa semana; `pre` es el ejercicio que se usa antes.
- `kind`: `"jump"` se saca con molestia de tobillo o partido; `"impact"` se reemplaza por su alternativa sin impacto con molestia fuerte.
- `exercises` agrega ejercicios nuevos o reemplaza los de la app con el mismo id. Campos: `name`, `cat`, `unit` (`reps`, `secs`, `min`, `rondas`, `rutina`), `range` [mín, máx], `perSide`, `rest`, `est` (segundos por repetición para el modo continuo), `hyp` (ejercicio de músculo), `levels`, `alt` (reemplazo en espacio reducido), `steps` (rutinas: `[["Posición", segundos], ...]`), `work`/`rest` (rondas), `fixed` (minutos fijos), `desc`, `cues`, `errors`, `q` (búsqueda de YouTube).
- Los niveles de cada ejercicio se guardan por id de ejercicio, así que se mantienen entre capítulos.
