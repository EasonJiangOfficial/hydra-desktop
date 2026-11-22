// The Hydra Agent on screen: the Hydra orb (hydra.js) with the agent layer on top. Monochrome: white to ink, no glow.
Roamie.register(Roamie.ditherKit({
  id: 'sidekick', label: 'Hydra', matrix: true, pixel: 1.3, glow: 0, speed: 80,
  pal: [[255, 255, 255], [229, 229, 234], [161, 161, 166], [110, 110, 115], [29, 29, 31]],
  plugin: (kit) => Roamie.agentPlugin?.(kit) ?? null,
}));
