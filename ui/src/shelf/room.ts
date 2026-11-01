import * as THREE from "three";

/**
 * The room the bookcase stands in: a rug, a window, framed pictures, a potted
 * plant and a small table with flowers. Everything is generated here (no image
 * assets), low-poly, and panned with the camera so every case gets the same
 * room around it.
 */

export interface RoomHandle {
  group: THREE.Group;
  setTheme(theme: "light" | "dark"): void;
  setPerformanceMode(enabled: boolean): void;
  dispose(): void;
}

interface Tintable {
  material: THREE.MeshStandardMaterial;
  light: number;
  dark: number;
}

const WALL_Z = -1.4;
const FLOOR_Y = -0.14;

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** A worn kilim: warm field, cream border, stepped diamond medallions. */
function rugTexture(): THREE.CanvasTexture {
  return canvasTexture(768, 432, (ctx) => {
    ctx.fillStyle = "#9c5b45";
    ctx.fillRect(0, 0, 768, 432);

    ctx.fillStyle = "#c98d63";
    ctx.fillRect(24, 24, 720, 384);
    ctx.fillStyle = "#93482f";
    ctx.fillRect(40, 40, 688, 352);

    // Inner field with two medallions.
    ctx.fillStyle = "#b8674a";
    ctx.fillRect(64, 64, 640, 304);
    for (const cx of [256, 512]) {
      ctx.save();
      ctx.translate(cx, 216);
      const rings: Array<{ radius: number; colour: string }> = [
        { radius: 128, colour: "#e8d3b4" },
        { radius: 104, colour: "#8d4029" },
        { radius: 80, colour: "#e4c7a2" },
        { radius: 54, colour: "#a95a3c" },
        { radius: 28, colour: "#f0e0c6" },
      ];
      for (const { radius: r, colour } of rings) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // Fringe-ish bands at the ends.
    ctx.fillStyle = "#e8d3b4";
    for (const x of [8, 744]) ctx.fillRect(x, 30, 16, 372);

    // A little grain so the flat colours do not read as vector art.
    const image = ctx.getImageData(0, 0, 768, 432);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 16;
      data[i] = (data[i] ?? 0) + noise;
      data[i + 1] = (data[i + 1] ?? 0) + noise;
      data[i + 2] = (data[i + 2] ?? 0) + noise;
    }
    ctx.putImageData(image, 0, 0);
  });
}

function paintingTexture(kind: "sun" | "leaf"): THREE.CanvasTexture {
  return canvasTexture(256, 320, (ctx) => {
    const paper = ctx.createLinearGradient(0, 0, 0, 320);
    paper.addColorStop(0, "#f2e6cf");
    paper.addColorStop(1, "#ddc9a8");
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, 256, 320);

    if (kind === "sun") {
      ctx.fillStyle = "#e0a14d";
      ctx.beginPath();
      ctx.arc(128, 150, 62, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#b8722f";
      ctx.lineWidth = 3;
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(128 + Math.cos(angle) * 76, 150 + Math.sin(angle) * 76);
        ctx.lineTo(128 + Math.cos(angle) * 96, 150 + Math.sin(angle) * 96);
        ctx.stroke();
      }
      ctx.fillStyle = "#6d8a6a";
      ctx.beginPath();
      ctx.moveTo(0, 320);
      ctx.quadraticCurveTo(90, 236, 256, 300);
      ctx.lineTo(256, 320);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = "#4f6b4c";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(128, 292);
      ctx.quadraticCurveTo(140, 190, 128, 78);
      ctx.stroke();
      ctx.fillStyle = "#5d7d58";
      for (let i = 0; i < 6; i += 1) {
        const y = 250 - i * 32;
        const side = i % 2 === 0 ? 1 : -1;
        ctx.save();
        ctx.translate(128, y);
        ctx.rotate(side * 0.6);
        ctx.beginPath();
        ctx.ellipse(0, -26, 16, 34, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = "#b98b5a";
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, 216, 280);
    }
  });
}

function windowTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 320, (ctx) => {
    const sky = ctx.createLinearGradient(0, 0, 0, 320);
    sky.addColorStop(0, "#cfe6f5");
    sky.addColorStop(0.55, "#eaf3f8");
    sky.addColorStop(1, "#f7eddb");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 256, 320);

    // Soft distant trees, so the glass is not a flat panel.
    ctx.fillStyle = "rgba(140, 173, 138, 0.55)";
    const trees: Array<[number, number]> = [
      [60, 42],
      [120, 56],
      [190, 38],
    ];
    for (const [x, r] of trees) {
      ctx.beginPath();
      ctx.arc(x, 300, r, Math.PI, 0);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    const clouds: Array<[number, number, number]> = [
      [40, 70, 70],
      [150, 46, 84],
    ];
    for (const [x, y, w] of clouds) {
      ctx.beginPath();
      ctx.ellipse(x, y, w, 20, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function addBox(
  parent: THREE.Object3D,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  shadows = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addCylinder(
  parent: THREE.Object3D,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  position: [number, number, number],
  material: THREE.Material,
  segments = 20,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    material,
  );
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * A tulip-style head: a tapering cup, three petals folded over the rim and a
 * pointed tip. Built with its base at the origin and growing up +Y, so it can be
 * dropped straight onto the end of a stem and inherit the stem's lean.
 */
function addBloom(
  parent: THREE.Object3D,
  material: THREE.Material,
  size: number,
): THREE.Group {
  const bloom = new THREE.Group();

  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34 * size, 0.14 * size, 0.66 * size, 10),
    material,
  );
  cup.position.y = 0.33 * size;
  cup.castShadow = true;
  bloom.add(cup);

  const petalGeometry = new THREE.SphereGeometry(0.19 * size, 7, 6);
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2;
    const petal = new THREE.Mesh(petalGeometry, material);
    petal.position.set(
      Math.cos(angle) * 0.16 * size,
      0.46 * size,
      Math.sin(angle) * 0.16 * size,
    );
    petal.scale.set(1, 1.8, 0.7);
    petal.rotation.set(0.34 * Math.cos(angle), -angle, 0.34 * Math.sin(angle));
    bloom.add(petal);
  }

  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.19 * size, 0.3 * size, 10),
    material,
  );
  tip.position.y = 0.74 * size;
  tip.castShadow = true;
  bloom.add(tip);

  parent.add(bloom);
  return bloom;
}

export function createRoom(theme: "light" | "dark"): RoomHandle {
  const group = new THREE.Group();
  group.name = "room";
  const tintable: Tintable[] = [];
  const textures: THREE.Texture[] = [];

  const tint = (
    material: THREE.MeshStandardMaterial,
    light: number,
    dark: number,
  ): THREE.MeshStandardMaterial => {
    tintable.push({ material, light, dark });
    return material;
  };

  const wood = tint(
    new THREE.MeshStandardMaterial({ color: 0x7a5231, roughness: 0.7 }),
    0x7a5231,
    0x5d4530,
  );
  const darkWood = tint(
    new THREE.MeshStandardMaterial({ color: 0x53381f, roughness: 0.75 }),
    0x53381f,
    0x3d2c1d,
  );
  const cream = tint(
    new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.9 }),
    0xe8dcc4,
    0x9c9080,
  );
  const terracotta = tint(
    new THREE.MeshStandardMaterial({ color: 0xb4653f, roughness: 0.95 }),
    0xb4653f,
    0x8a4c30,
  );
  const soil = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1 });
  const leaf = tint(
    new THREE.MeshStandardMaterial({ color: 0x4a7350, roughness: 0.85, side: THREE.DoubleSide }),
    0x4a7350,
    0x35543c,
  );
  const leafDark = tint(
    new THREE.MeshStandardMaterial({ color: 0x395c40, roughness: 0.85 }),
    0x395c40,
    0x2a4230,
  );
  const linen = new THREE.MeshStandardMaterial({ color: 0xf1e3c8, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xdfe9ee,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.3,
    // Both faces and no depth writes, so stems stay visible through the vase
    // instead of the near wall hiding whatever is behind it.
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bloomMaterials = [0xd4636b, 0xe8a0a8, 0xf0cf8a, 0xc9556d].map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
  );
  // Wraps around, so callers can pass any integer (including a negative one)
  // without indexing out of the palette.
  const bloomFor = (index: number): THREE.MeshStandardMaterial => {
    const count = bloomMaterials.length;
    const material = bloomMaterials[((index % count) + count) % count];
    if (material) return material;
    return new THREE.MeshStandardMaterial({ color: 0xd4636b, roughness: 0.7 });
  };
  const paperWhite = tint(
    new THREE.MeshStandardMaterial({ color: 0xf3ead7, roughness: 0.9 }),
    0xf3ead7,
    0xbfb5a3,
  );

  // ------------------------------------------------------------------ rug

  const rugMap = rugTexture();
  textures.push(rugMap);
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(13.5, 7.6),
    new THREE.MeshStandardMaterial({ map: rugMap, roughness: 1 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0.2, FLOOR_Y + 0.012, 5.0);
  rug.receiveShadow = true;
  group.add(rug);

  // --------------------------------------------------------------- window

  const windowGroup = new THREE.Group();
  windowGroup.position.set(-6.05, 5.9, WALL_Z + 0.03);
  group.add(windowGroup);

  const paneMap = windowTexture();
  textures.push(paneMap);
  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 3.3),
    new THREE.MeshStandardMaterial({
      map: paneMap,
      emissive: new THREE.Color(0xfff2da),
      emissiveMap: paneMap,
      emissiveIntensity: theme === "dark" ? 0.85 : 0.35,
      roughness: 1,
    }),
  );
  pane.position.z = 0.02;
  windowGroup.add(pane);
  const paneMaterial = pane.material;

  // Frame: four boards plus a cross mullion and a sill.
  addBox(windowGroup, [3.1, 0.22, 0.28], [0, 1.76, 0.06], cream);
  addBox(windowGroup, [3.1, 0.22, 0.28], [0, -1.76, 0.06], cream);
  addBox(windowGroup, [0.22, 3.7, 0.28], [-1.54, 0, 0.06], cream);
  addBox(windowGroup, [0.22, 3.7, 0.28], [1.54, 0, 0.06], cream);
  addBox(windowGroup, [0.1, 3.3, 0.16], [0, 0, 0.08], cream, false);
  addBox(windowGroup, [2.6, 0.1, 0.16], [0, 0.1, 0.08], cream, false);
  addBox(windowGroup, [3.5, 0.18, 0.5], [0, -1.9, 0.2], cream);

  // ---------------------------------------------------------- wall pictures

  const frameFor = (
    x: number,
    y: number,
    width: number,
    height: number,
    kind: "sun" | "leaf",
  ): void => {
    const map = paintingTexture(kind);
    textures.push(map);
    const picture = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({ map, roughness: 0.95 }),
    );
    picture.position.set(x, y, WALL_Z + 0.035);
    group.add(picture);
    addBox(group, [width + 0.22, 0.12, 0.1], [x, y + height / 2 + 0.05, WALL_Z + 0.05], darkWood);
    addBox(group, [width + 0.22, 0.12, 0.1], [x, y - height / 2 - 0.05, WALL_Z + 0.05], darkWood);
    addBox(group, [0.12, height + 0.22, 0.1], [x - width / 2 - 0.05, y, WALL_Z + 0.05], darkWood);
    addBox(group, [0.12, height + 0.22, 0.1], [x + width / 2 + 0.05, y, WALL_Z + 0.05], darkWood);
    addBox(group, [width + 0.12, height + 0.22, 0.05], [x, y, WALL_Z - 0.01], paperWhite, false);
  };
  frameFor(5.85, 6.35, 1.55, 1.95, "sun");
  frameFor(5.95, 3.95, 1.15, 1.45, "leaf");

  // --------------------------------------------------------- skirting board

  addBox(
    group,
    [240, 0.5, 0.22],
    [0, FLOOR_Y + 0.25, WALL_Z + 0.09],
    cream,
    false,
  );

  // ----------------------------------------------------------------- plant

  const plant = new THREE.Group();
  plant.position.set(-5.5, FLOOR_Y, 1.25);
  group.add(plant);

  addCylinder(plant, 0.62, 0.46, 0.9, [0, 0.45, 0], terracotta, 24);
  addCylinder(plant, 0.66, 0.62, 0.14, [0, 0.92, 0], terracotta, 24);
  const soilDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.06, 20), soil);
  soilDisc.position.y = 0.98;
  plant.add(soilDisc);

  const leafGeometry = new THREE.SphereGeometry(0.34, 10, 7);
  const stems: Array<[number, number, number, number]> = [
    [0.02, 1.0, 2.9, 0.1],
    [-0.12, 1.6, 2.5, -0.6],
    [0.14, 1.9, 2.35, 0.7],
    [-0.05, 2.4, 1.9, -0.25],
    [0.1, 1.2, 3.15, 1.4],
    [-0.16, 2.0, 2.05, 2.2],
  ];
  // Each stem is its own pivot at the soil line: the shaft grows up from the
  // pivot, leaves and the flower hang off it, and the whole thing leans as one
  // piece. That keeps every flower attached to the top of its stem.
  for (const [index, [x, z, height, spin]] of stems.entries()) {
    const stem = new THREE.Group();
    stem.position.set(x, 0.95, z * 0.22);
    stem.rotation.set(Math.sin(spin) * 0.11, 0, Math.cos(spin) * 0.11);
    plant.add(stem);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.05, height, 6).translate(0, height / 2, 0),
      leafDark,
    );
    shaft.castShadow = false;
    stem.add(shaft);

    for (let i = 0; i < 3; i += 1) {
      const leafMesh = new THREE.Mesh(leafGeometry, i % 2 === 0 ? leaf : leafDark);
      // Kept low on the stem, so the flower at the tip stays visible.
      const along = 0.34 + i * 0.17;
      const face = spin + i * 1.9;
      const reach = 0.13 + (i % 2) * 0.05;
      leafMesh.position.set(
        Math.cos(face) * reach,
        height * along,
        Math.sin(face) * reach,
      );
      leafMesh.scale.set(0.85 + (i % 2) * 0.2, 0.1, 0.4 + (i % 3) * 0.05);
      // Tilted off the horizontal, so the leaves fan out instead of stacking
      // into a column of discs.
      leafMesh.rotation.set(0.42 * Math.cos(face), face, -0.62 - 0.14 * i);
      leafMesh.castShadow = true;
      stem.add(leafMesh);
    }

    const bloom = addBloom(stem, bloomFor(index), 0.52 + (index % 3) * 0.05);
    bloom.position.y = height;
    bloom.rotation.y = spin;
  }

  // ----------------------------------------------------------- side table

  const table = new THREE.Group();
  table.position.set(5.65, FLOOR_Y, 1.1);
  table.rotation.y = -0.14;
  group.add(table);

  const topY = 1.15;
  addCylinder(table, 0.95, 0.95, 0.11, [0, topY, 0], wood, 28);
  addCylinder(table, 0.85, 0.85, 0.06, [0, topY - 0.11, 0], darkWood, 24);
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2 + 0.4;
    const leg = addCylinder(
      table,
      0.055,
      0.075,
      topY - 0.16,
      [Math.cos(angle) * 0.62, (topY - 0.16) / 2, Math.sin(angle) * 0.62],
      darkWood,
      10,
    );
    leg.rotation.z = Math.cos(angle) * 0.09;
    leg.rotation.x = -Math.sin(angle) * 0.09;
  }

  // A short stack of books on the table.
  addBox(table, [0.62, 0.11, 0.46], [-0.28, topY + 0.11, 0.06], new THREE.MeshStandardMaterial({ color: 0x8d4b3d, roughness: 0.75 }));
  addBox(table, [0.58, 0.09, 0.44], [-0.3, topY + 0.21, 0.04], new THREE.MeshStandardMaterial({ color: 0x3f5d6b, roughness: 0.75 }));
  addBox(table, [0.54, 0.07, 0.42], [-0.26, topY + 0.29, 0.08], new THREE.MeshStandardMaterial({ color: 0xd8c49c, roughness: 0.8 }));

  // Mug.
  addCylinder(table, 0.15, 0.13, 0.24, [0.36, topY + 0.17, -0.3], cream, 16);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 6, 12), cream);
  handle.position.set(0.51, topY + 0.18, -0.3);
  handle.rotation.y = Math.PI / 2;
  handle.castShadow = true;
  table.add(handle);

  // Vase of flowers. The vase sits on the table top; every stem pivots at the
  // mouth of the vase and carries its own flower at the tip, so the tulips lean
  // with their stems and nothing floats free of the glass.
  const vaseX = 0.15;
  const vaseZ = 0.42;
  const vaseMouthY = topY + 0.57;
  addCylinder(table, 0.17, 0.13, 0.52, [vaseX, topY + 0.31, vaseZ], glass, 18);
  const vaseRim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.014, 6, 18), glass);
  vaseRim.position.set(vaseX, vaseMouthY, vaseZ);
  vaseRim.rotation.x = Math.PI / 2;
  table.add(vaseRim);
  const vaseWater = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.13, 0.3, 16),
    new THREE.MeshStandardMaterial({
      color: 0xc7dcd2,
      roughness: 0.25,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );
  vaseWater.position.set(vaseX, topY + 0.24, vaseZ);
  vaseWater.castShadow = false;
  table.add(vaseWater);
  const stemMaterial = new THREE.MeshStandardMaterial({ color: 0x4c7049, roughness: 0.8 });
  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2 + 0.25;
    const lean = 0.15 + (i % 2) * 0.1;
    const length = 0.74 + (i % 3) * 0.08;
    const stem = new THREE.Group();
    stem.position.set(vaseX, topY + 0.3, vaseZ);
    // Small-angle lean toward `angle`: +X tilts by -z rotation, +Z by +x.
    stem.rotation.set(Math.sin(angle) * lean, 0, -Math.cos(angle) * lean);
    table.add(stem);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.019, 0.024, length, 5).translate(0, length / 2, 0),
      stemMaterial,
    );
    stem.add(shaft);

    const head = addBloom(stem, bloomFor(i), 0.42);
    head.position.y = length;
    head.rotation.y = angle;
  }

  // A folded paper and a candle jar, for a lived-in table.
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.62),
    new THREE.MeshStandardMaterial({ color: 0xf6efe0, roughness: 0.95 }),
  );
  paper.rotation.x = -Math.PI / 2;
  paper.rotation.z = 0.3;
  paper.position.set(0.62, topY + 0.06, 0.12);
  paper.receiveShadow = true;
  table.add(paper);
  const candle = addCylinder(table, 0.13, 0.12, 0.26, [-0.55, topY + 0.18, 0.44], linen, 14);
  candle.castShadow = true;

  const applyTheme = (next: "light" | "dark"): void => {
    for (const entry of tintable) {
      entry.material.color.setHex(next === "dark" ? entry.dark : entry.light);
    }
    paneMaterial.emissiveIntensity = next === "dark" ? 0.95 : 0.35;
    rug.material.color.setHex(next === "dark" ? 0x8f7d6c : 0xffffff);
  };
  applyTheme(theme);

  return {
    group,
    setTheme: applyTheme,
    setPerformanceMode(enabled: boolean): void {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = !enabled;
      });
    },
    dispose(): void {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const material = mesh.material;
        for (const entry of Array.isArray(material) ? material : [material]) {
          entry.dispose();
        }
      });
      for (const texture of textures) texture.dispose();
      group.removeFromParent();
    },
  };
}
