import clear from './assets/clear.svg';
import partlyCloudy from './assets/partly-cloudy.svg';
import overcast from './assets/overcast.svg';
import fog from './assets/fog.svg';
import drizzle from './assets/drizzle.svg';
import rain from './assets/rain.svg';
import snow from './assets/snow.svg';
import sleet from './assets/sleet.svg';
import thunderstorm from './assets/thunderstorm.svg';
import type { WeatherArtKind } from './weather-preference';

export const weatherArt: Record<WeatherArtKind, string> = {
  clear, 'partly-cloudy': partlyCloudy, overcast, fog, drizzle, rain, snow, sleet, thunderstorm
};
