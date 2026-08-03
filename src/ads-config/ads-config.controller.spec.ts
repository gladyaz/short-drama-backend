import { Test, TestingModule } from '@nestjs/testing';
import { AdsConfigController } from './ads-config.controller';
import { AdsConfigService } from './ads-config.service';
import { AdsConfig, DEFAULT_ADS_CONFIG } from './ads-config.types';

describe('AdsConfigController', () => {
  let controller: AdsConfigController;
  let getConfig: jest.Mock<AdsConfig, []>;

  beforeEach(async () => {
    getConfig = jest.fn<AdsConfig, []>().mockReturnValue(DEFAULT_ADS_CONFIG);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdsConfigController],
      providers: [{ provide: AdsConfigService, useValue: { getConfig } }],
    }).compile();

    controller = module.get<AdsConfigController>(AdsConfigController);
  });

  it('returns exactly the five-field AdsConfigService result, untouched', () => {
    const result = controller.getAdsConfig();

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(result).toEqual(DEFAULT_ADS_CONFIG);
    expect(Object.keys(result).sort()).toEqual([
      'enabled',
      'graceVideos',
      'maxVideosBetweenAds',
      'minSecondsBetweenAds',
      'minVideosBetweenAds',
    ]);
  });

  it('forwards a non-default config verbatim', () => {
    const custom: AdsConfig = {
      enabled: false,
      minVideosBetweenAds: 2,
      maxVideosBetweenAds: 4,
      minSecondsBetweenAds: 30,
      graceVideos: 1,
    };
    getConfig.mockReturnValue(custom);

    expect(controller.getAdsConfig()).toEqual(custom);
  });
});
