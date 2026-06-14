const VIEWPORT_PX = 1280;

function span(zoom) {
  return VIEWPORT_PX * 360 / (256 * 2 ** zoom);
}

function inverseSpan(south,north,west,east){
  let width=Math.abs(parseFloat(west)-parseFloat(east));
  let height=Math.abs(parseFloat(south)-parseFloat(north));
  let spread = Math.max(width, height);

  let zoom=Math.floor(Math.log((VIEWPORT_PX*360)/256/spread)/Math.log(2));
  return zoom;
}
class Cell {
  constructor({ lat, lng, zoom }) {
    this.lat = lat;
    this.lng = lng;
    this.zoom = zoom;
  }

  subdivide() {
    const s = span(this.zoom);
    return [
      new Cell({ lat: this.lat - s/4, lng: this.lng - s/4, zoom: this.zoom + 1 }),
      new Cell({ lat: this.lat + s/4, lng: this.lng - s/4, zoom: this.zoom + 1 }),
      new Cell({ lat: this.lat - s/4, lng: this.lng + s/4, zoom: this.zoom + 1 }),
      new Cell({ lat: this.lat + s/4, lng: this.lng + s/4, zoom: this.zoom + 1 }),
    ];
  }
}

module.exports = Cell;
module.exports.inverseSpan = inverseSpan;
