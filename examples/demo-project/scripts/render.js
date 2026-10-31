const fs = require('node:fs')
const path = require('node:path')

// The texture is referenced both from the project root and relative to this file.
const textureFromRoot = 'assets/textures/old_brick_wall.png'
const textureFromScript = path.join(__dirname, '..', 'assets', 'textures', 'old_brick_wall.png')

function readTexture() {
  return fs.readFileSync('../assets/textures/old_brick_wall.png')
}

module.exports = { textureFromRoot, textureFromScript, readTexture }
