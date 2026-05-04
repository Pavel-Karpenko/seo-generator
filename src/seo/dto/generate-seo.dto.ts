import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class GenerateSeoDto {
  @IsString()
  @IsNotEmpty({ message: 'product_name must not be empty' })
  @MaxLength(200, {
    message: 'product_name must be at most 200 characters',
  })
  product_name!: string;

  @IsString()
  @IsNotEmpty({ message: 'category must not be empty' })
  @MaxLength(100, {
    message: 'category must be at most 100 characters',
  })
  category!: string;

  @IsArray({ message: 'keywords must be an array of strings' })
  @ArrayMinSize(1, { message: 'keywords must contain at least 1 keyword' })
  @ArrayMaxSize(10, { message: 'keywords must contain at most 10 keywords' })
  @IsString({ each: true, message: 'each keyword must be a string' })
  @MaxLength(50, { each: true, message: 'each keyword must be at most 50 characters' })
  keywords!: string[];

  /**
   * Optional session ID for chat history continuity across requests.
   * If provided, must be a valid UUID.
   */
  @IsOptional()
  @IsString()
  @IsUUID('4', { message: 'session_id must be a valid UUID v4 if provided' })
  session_id?: string;
}
