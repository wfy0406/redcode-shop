/**
 * Glo Glo 精選配搭指南 —— 公開 DTO。
 * 單一來源係 @contracts/gloGuide（server 同 client 共用凍結合同），
 * 呢度只 re-export，唔維持第二份會漂移嘅型別。
 */

export type { GuideProduct, GuideImage, GuideListItem, GuideDetail } from '@contracts/gloGuide';
