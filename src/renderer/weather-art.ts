import clear from './assets/weather/clear.svg';
import partlyCloudy from './assets/weather/partly-cloudy.svg';
import overcast from './assets/weather/overcast.svg';
import fog from './assets/weather/fog.svg';
import drizzle from './assets/weather/drizzle.svg';
import rain from './assets/weather/rain.svg';
import snow from './assets/weather/snow.svg';
import sleet from './assets/weather/sleet.svg';
import thunderstorm from './assets/weather/thunderstorm.svg';
import type { WeatherArtKind } from './weather-preference';

export const weatherArt: Record<WeatherArtKind, string> = {
  clear, 'partly-cloudy': partlyCloudy, overcast, fog, drizzle, rain, snow, sleet, thunderstorm
};
